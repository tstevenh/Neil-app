import axios from "axios";
import { load } from "cheerio";
import {
  APIFY_COMPARE_FALLBACK_TO_LOCAL,
  APIFY_COMPARE_FETCH_ENABLED,
  APIFY_COMPARE_TIMEOUT_MS,
  APIFY_USE_PROXY,
  FETCH_PAGE_NAVIGATION_DELAY_MS,
  REQUEST_TIMEOUT_MS,
} from "@/lib/runtime-config";
import { normalizeMetaText } from "@/lib/url";

const APIFY_DEFAULT_ACTOR = "apify/website-content-crawler";
const KEEP_ALL_HTML_SELECTOR = "codex-keep-all-elements";

type PageData = {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  description: string;
  html: string;
  usedRenderer: "apify" | "static" | "playwright";
};

type FetchStrategy = "apify-first" | "local-only";

type FetchPageOptions = {
  cookieHeader?: string;
  strategy?: FetchStrategy;
  useApifyProxy?: boolean;
};

type ApifyCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
};

type ApifyDatasetItem = {
  url?: string;
  loadedUrl?: string;
  html?: string;
  crawl?: {
    loadedUrl?: string;
  };
};

const DEFAULT_BROWSER_USER_AGENT =
  process.env.DEFAULT_BROWSER_USER_AGENT?.trim() ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

type BrowserLike = {
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
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseFromHtml(requestedUrl: string, finalUrl: string, html: string, usedRenderer: PageData["usedRenderer"]): PageData {
  const $ = load(html);
  const title = normalizeMetaText($("title").first().text());
  const description = normalizeMetaText($("meta[name='description']").first().attr("content") ?? "");

  return {
    requestedUrl,
    finalUrl,
    title,
    description,
    html,
    usedRenderer,
  };
}

function normalizeApifyActorIdentifier(value: string) {
  if (value.includes("~")) {
    return value;
  }
  if (value.includes("/")) {
    return value.replace("/", "~");
  }
  return value;
}

function parseCookieHeader(cookieHeader: string, domain: string): ApifyCookie[] {
  if (!cookieHeader.trim()) {
    return [];
  }

  const cookies: ApifyCookie[] = [];
  for (const entry of cookieHeader.split(";")) {
    const item = entry.trim();
    if (!item) {
      continue;
    }

    const separator = item.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (!name) {
      continue;
    }

    cookies.push({
      name,
      value,
      domain,
      path: "/",
    });
  }

  return cookies;
}

function getApifyConfig() {
  const token = process.env.APIFY_API_TOKEN?.trim();
  const actorId = process.env.APIFY_ACTOR_ID?.trim() || APIFY_DEFAULT_ACTOR;
  if (!token) {
    throw new Error("Missing APIFY_API_TOKEN");
  }
  return {
    token,
    actorId: normalizeApifyActorIdentifier(actorId),
  };
}

function describeApifyError(error: unknown) {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status === 402) {
      return "Apify billing limit reached. Top up credits or upgrade the Apify plan.";
    }
    if (status === 401) {
      return "Apify authentication failed. Check APIFY_API_TOKEN.";
    }
    if (status === 403) {
      return "Apify request was forbidden. Check actor access and token permissions.";
    }
    if (status === 429) {
      return "Apify rate limit reached. Retry in a moment.";
    }
    if (status) {
      return `Apify request failed with HTTP ${status}`;
    }
    return error.message || "Unknown Apify request error";
  }

  return error instanceof Error ? error.message : "Unknown Apify error";
}

async function tryApify(url: string, options: FetchPageOptions): Promise<PageData> {
  try {
    const { token, actorId } = getApifyConfig();
    const parsedUrl = new URL(url);
    const response = await axios.post<ApifyDatasetItem[]>(
      `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items`,
      {
        startUrls: [{ url }],
        crawlerType: "playwright:adaptive",
        maxCrawlPages: 1,
        maxResults: 1,
        maxCrawlDepth: 0,
        useSitemaps: false,
        respectRobotsTxtFile: false,
        maxRequestRetries: 1,
        requestTimeoutSecs: Math.ceil(APIFY_COMPARE_TIMEOUT_MS / 1000),
        maxConcurrency: 1,
        saveHtml: true,
        saveMarkdown: false,
        htmlTransformer: "none",
        removeElementsCssSelector: KEEP_ALL_HTML_SELECTOR,
        initialCookies: parseCookieHeader(options.cookieHeader ?? "", parsedUrl.hostname),
        customHttpHeaders: {
          "User-Agent": DEFAULT_BROWSER_USER_AGENT,
          "Accept-Language": "en-US,en;q=0.9",
          ...(options.cookieHeader ? { Cookie: options.cookieHeader } : {}),
        },
        proxyConfiguration: (options.useApifyProxy ?? APIFY_USE_PROXY) ? { useApifyProxy: true } : undefined,
      },
      {
        timeout: APIFY_COMPARE_TIMEOUT_MS,
        params: { token, clean: true },
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );

    const item = Array.isArray(response.data) ? response.data[0] : null;
    if (!item) {
      throw new Error("Apify compare fetch returned no dataset items");
    }

    const html = typeof item.html === "string" ? item.html : "";
    if (!html.trim()) {
      throw new Error("Apify compare fetch returned no HTML");
    }

    const finalUrl = item.loadedUrl ?? item.crawl?.loadedUrl ?? item.url ?? url;
    return parseFromHtml(url, finalUrl, html, "apify");
  } catch (error) {
    throw new Error(describeApifyError(error));
  }
}

function shouldUseServerlessPlaywright() {
  return Boolean(process.env.VERCEL) || Boolean(process.env.AWS_EXECUTION_ENV) || process.env.NODE_ENV === "production";
}

async function launchFallbackBrowser(): Promise<BrowserLike> {
  if (shouldUseServerlessPlaywright()) {
    const [{ chromium: playwrightChromium }, chromium] = await Promise.all([
      import("playwright-core"),
      import("@sparticuz/chromium"),
    ]);

    return playwrightChromium.launch({
      args: chromium.default.args,
      executablePath: await chromium.default.executablePath(),
      headless: true,
    }) as Promise<BrowserLike>;
  }

  const playwright = await import("playwright");
  return playwright.chromium.launch({ headless: true }) as Promise<BrowserLike>;
}

async function tryPlaywright(url: string, options: FetchPageOptions): Promise<PageData> {
  let browser: BrowserLike | null = null;
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
    browser = await launchFallbackBrowser();
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
    return parseFromHtml(url, finalUrl, html, "playwright");
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Unknown Playwright error");
  } finally {
    if (context) {
      await context.close().catch(() => undefined);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

async function tryStatic(url: string, options: FetchPageOptions): Promise<PageData> {
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

    return parseFromHtml(url, response.request?.res?.responseUrl ?? url, response.data, "static");
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      if (status) {
        throw new Error(`HTTP ${status}`);
      }
      throw new Error(error.message || "Axios request failed");
    }
    throw new Error(error instanceof Error ? error.message : "Unknown static fetch error");
  }
}

export async function fetchPage(url: string, options: FetchPageOptions = {}): Promise<PageData> {
  const strategy = options.strategy ?? "local-only";
  const failures: string[] = [];

  if (strategy === "apify-first" && APIFY_COMPARE_FETCH_ENABLED) {
    try {
      return await tryApify(url, options);
    } catch (error) {
      failures.push(`apify: ${error instanceof Error ? error.message : "Unknown error"}`);
      if (!APIFY_COMPARE_FALLBACK_TO_LOCAL) {
        throw new Error(`Unable to fetch URL: ${url} (${failures.join("; ")})`);
      }
    }
  }

  try {
    return await tryPlaywright(url, options);
  } catch (error) {
    failures.push(`playwright: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  try {
    return await tryStatic(url, options);
  } catch (error) {
    failures.push(`static: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  throw new Error(`Unable to fetch URL: ${url} (${failures.join("; ")})`);
}

export type { FetchPageOptions, PageData };
