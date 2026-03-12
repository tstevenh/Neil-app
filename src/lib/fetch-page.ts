import axios from "axios";
import { load } from "cheerio";
import {
  APIFY_COMPARE_FALLBACK_TO_LOCAL,
  APIFY_COMPARE_FETCH_ENABLED,
  APIFY_COMPARE_TIMEOUT_MS,
  APIFY_USE_PROXY,
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
  descriptionSource: "meta:description" | "none";
  metadataRenderer: "apify" | "static";
  html: string;
  usedRenderer: "apify" | "static";
};

type DescriptionSource = PageData["descriptionSource"];

type FetchStrategy = "apify-first" | "static-only" | "local-only";

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

function extractMetaDescription($: ReturnType<typeof load>): { content: string; source: DescriptionSource } {
  const selectors = [
    { selector: "meta[name='description']", source: "meta:description" as const },
    { selector: "meta[name='Description']", source: "meta:description" as const },
    { selector: "meta[name='DESCRIPTION']", source: "meta:description" as const },
  ];

  for (const entry of selectors) {
    const content = $(entry.selector).first().attr("content")?.trim();
    if (content) {
      return { content, source: entry.source };
    }
  }

  // Case-insensitive fallback for unusual markup
  const metaTags = $("meta").toArray();
  for (const tag of metaTags) {
    const $tag = $(tag);
    const name = ($tag.attr("name") || $tag.attr("property") || "").trim().toLowerCase();
    if (name === "description") {
      const content = $tag.attr("content")?.trim();
      if (content) {
        return { content, source: "meta:description" };
      }
    }
  }

  return { content: "", source: "none" as const };
}

function parseFromHtml(
  requestedUrl: string,
  finalUrl: string,
  html: string,
  usedRenderer: PageData["usedRenderer"],
): PageData {
  const $ = load(html);
  const title = normalizeMetaText($("title").first().text());
  const extractedDescription = extractMetaDescription($);
  const description = normalizeMetaText(extractedDescription.content);

  return {
    requestedUrl,
    finalUrl,
    title,
    description,
    descriptionSource: description ? extractedDescription.source : "none",
    metadataRenderer: usedRenderer,
    html,
    usedRenderer,
  };
}

export function parsePageDataFromHtml(
  requestedUrl: string,
  finalUrl: string,
  html: string,
  usedRenderer: PageData["usedRenderer"],
): PageData {
  return parseFromHtml(requestedUrl, finalUrl, html, usedRenderer);
}

function mergePageMetadata(primary: PageData, secondary: PageData): PageData {
  return {
    ...primary,
    finalUrl: primary.finalUrl || secondary.finalUrl,
    title: primary.title || secondary.title,
    description: primary.description || secondary.description,
    descriptionSource: primary.description ? primary.descriptionSource : secondary.descriptionSource,
    metadataRenderer: primary.description ? primary.metadataRenderer : secondary.metadataRenderer,
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
        crawlerType: "cheerio",
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
    const apifyPage = parseFromHtml(url, finalUrl, html, "apify");
    if (apifyPage.title && apifyPage.description) {
      return apifyPage;
    }

    try {
      const staticPage = await tryStatic(finalUrl, options);
      return mergePageMetadata(apifyPage, staticPage);
    } catch {
      return apifyPage;
    }
  } catch (error) {
    throw new Error(describeApifyError(error));
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
  const strategy = options.strategy ?? "static-only";
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
    return await tryStatic(url, options);
  } catch (error) {
    failures.push(`static: ${error instanceof Error ? error.message : "Unknown error"}`);
  }

  throw new Error(`Unable to fetch URL: ${url} (${failures.join("; ")})`);
}

export type { FetchPageOptions, PageData };
