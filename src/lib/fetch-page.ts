import axios from "axios";
import { load } from "cheerio";
import { normalizeMetaText } from "@/lib/url";

const REQUEST_TIMEOUT_MS = 10_000;

type PageData = {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  description: string;
  html: string;
  usedRenderer: "static" | "playwright";
};

function parseFromHtml(requestedUrl: string, finalUrl: string, html: string, usedRenderer: PageData["usedRenderer"]): PageData {
  const $ = load(html);
  const title = normalizeMetaText($("title").first().text());
  const description = normalizeMetaText(
    $("meta[name='description']").first().attr("content") ?? "",
  );

  return {
    requestedUrl,
    finalUrl,
    title,
    description,
    html,
    usedRenderer,
  };
}

async function tryPlaywright(url: string): Promise<PageData | null> {
  let browser:
    | {
        newPage: () => Promise<{
          goto: (
            target: string,
            options: { waitUntil: "domcontentloaded"; timeout: number },
          ) => Promise<{ url: () => string } | null>;
          content: () => Promise<string>;
          url: () => string;
        }>;
        close: () => Promise<void>;
      }
    | null = null;
  try {
    const playwright = await import("playwright");
    browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: REQUEST_TIMEOUT_MS,
    });

    const html = await page.content();
    const finalUrl = response?.url() ?? page.url() ?? url;
    await browser.close();
    browser = null;

    return parseFromHtml(url, finalUrl, html, "playwright");
  } catch {
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

export async function fetchPage(url: string): Promise<PageData> {
  const rendered = await tryPlaywright(url);
  if (rendered) {
    return rendered;
  }

  try {
    const response = await axios.get<string>(url, {
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 10,
      responseType: "text",
      validateStatus: (status) => status >= 200 && status < 400,
      headers: {
        "User-Agent": "Meta-URL-QA-Checker/0.1",
      },
    });

    return parseFromHtml(
      url,
      response.request?.res?.responseUrl ?? url,
      response.data,
      "static",
    );
  } catch {
    throw new Error(`Unable to fetch URL: ${url}`);
  }
}
