import axios from "axios";
import { load } from "cheerio";
import { FETCH_PAGE_NAVIGATION_DELAY_MS, REQUEST_TIMEOUT_MS } from "@/lib/runtime-config";
import { normalizeMetaText } from "@/lib/url";

type PageData = {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  description: string;
  html: string;
  usedRenderer: "static" | "playwright";
};

type FetchPageOptions = {
  cookieHeader?: string;
};

const DEFAULT_BROWSER_USER_AGENT =
  process.env.DEFAULT_BROWSER_USER_AGENT?.trim() ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function tryPlaywright(url: string, options: FetchPageOptions): Promise<PageData | null> {
  let browser:
    | {
        newContext: (options?: {
          userAgent?: string;
          locale?: string;
          extraHTTPHeaders?: Record<string, string>;
        }) => Promise<{
          newPage: () => Promise<{
            goto: (
              target: string,
              options: { waitUntil: "domcontentloaded"; timeout: number },
            ) => Promise<{ url: () => string } | null>;
            content: () => Promise<string>;
            url: () => string;
          }>;
          close: () => Promise<void>;
        }>;
        close: () => Promise<void>;
      }
    | null = null;
  let context:
    | {
        close: () => Promise<void>;
        newPage: () => Promise<{
          goto: (
            target: string,
            options: { waitUntil: "domcontentloaded"; timeout: number },
          ) => Promise<{ url: () => string } | null>;
          content: () => Promise<string>;
          url: () => string;
        }>;
      }
    | null = null;
  try {
    const playwright = await import("playwright");
    browser = await playwright.chromium.launch({ headless: true });
    context = await browser.newContext({
      userAgent: DEFAULT_BROWSER_USER_AGENT,
      locale: "en-US",
      extraHTTPHeaders: options.cookieHeader ? { Cookie: options.cookieHeader } : undefined,
    });
    const page = await context.newPage();
    if (FETCH_PAGE_NAVIGATION_DELAY_MS > 0) {
      await delay(FETCH_PAGE_NAVIGATION_DELAY_MS);
    }
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: REQUEST_TIMEOUT_MS,
    });

    const html = await page.content();
    const finalUrl = response?.url() ?? page.url() ?? url;
    await context.close().catch(() => undefined);
    context = null;
    await browser.close();
    browser = null;

    return parseFromHtml(url, finalUrl, html, "playwright");
  } catch {
    return null;
  } finally {
    if (context) {
      await context.close().catch(() => undefined);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<PageData> {
  const rendered = await tryPlaywright(url, options);
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
        "User-Agent": DEFAULT_BROWSER_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        ...(options.cookieHeader ? { Cookie: options.cookieHeader } : {}),
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
