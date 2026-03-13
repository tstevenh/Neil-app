import axios from "axios";
import { load } from "cheerio";
import {
  type ApifyDatasetItem,
  fetchPage,
  hasCompletePageMetadata,
  parsePageDataFromApifyItem,
  parsePageDataFromHtml,
  repairIncompletePageData,
} from "@/lib/fetch-page";
import {
  APIFY_DISCOVERY_FALLBACK_TO_LOCAL,
  APIFY_MAX_CONCURRENCY,
  APIFY_POLL_RETRY_COUNT,
  APIFY_POLL_RETRY_DELAY_MS,
  APIFY_USE_PROXY,
  LOCAL_DISCOVERY_DELAY_MS,
  MAX_DISCOVERY_PAGES_PER_SITE,
  REQUEST_TIMEOUT_MS,
} from "@/lib/runtime-config";
import { assertSafePublicUrl } from "@/lib/security";
import type { DiscoveryPageSnapshot, UrlPair } from "@/lib/types";
import { resolveHref } from "@/lib/url";

const NON_HTML_EXTENSION_RE = /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|bmp|tiff|mp4|mp3|wav|zip|rar|7z|gz|tar|xml|json|txt|css|js)$/i;
const APIFY_DEFAULT_ACTOR = "apify/website-content-crawler";
const APIFY_DATASET_PAGE_SIZE = 100;
const EXCLUDED_DISCOVERY_PATH_PATTERNS = [
  /^\/cdn-cgi(?:\/|$)/i,
  /^\/wp-json(?:\/|$)/i,
  /^\/wp-admin(?:\/|$)/i,
  /^\/wp-login\.php$/i,
  /^\/wp-cron\.php$/i,
  /^\/xmlrpc\.php$/i,
  /^\/(?:.+\/)?feed\/?$/i,
];

type SideKey = "production" | "staging";
type SideProvider = "apify" | "static" | "done";

type ApifyRunResponse = {
  data?: {
    id?: string;
    defaultDatasetId?: string;
    status?: string;
  };
};

type ApifyAbortResponse = {
  data?: {
    id?: string;
    status?: string;
  };
};

type ApifyCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
};

export type DiscoverySideState = {
  rootUrl: string;
  rootPath: string;
  origin: string;
  host: string;
  allowedHosts: string[];
  cookieHeader: string;
  provider: SideProvider;
  apifyRunId: string;
  apifyDatasetId: string;
  apifyOffset: number;
  apifyFinished: boolean;
  rootRedirectedToProduction: boolean;
  queue: string[];
  visited: string[];
};

export type DiscoveryPathState = {
  rowIndex: number;
  productionUrl: string;
  stagingUrl: string;
  discoveredOnProduction: boolean;
  discoveredOnStaging: boolean;
  needsCompare: boolean;
  comparedCount: number;
};

export type DiscoveryJobState = {
  maxPagesPerSite: number;
  useApifyProxy: boolean;
  nextRowIndex: number;
  warnings: string[];
  paths: Record<string, DiscoveryPathState>;
  pageCache: {
    production: Record<string, DiscoveryPageSnapshot>;
    staging: Record<string, DiscoveryPageSnapshot>;
  };
  production: DiscoverySideState;
  staging: DiscoverySideState;
};

export type CreateDiscoveryStateInput = {
  productionRootUrl: string;
  stagingRootUrl: string;
  productionCookieHeader?: string;
  stagingCookieHeader?: string;
  maxPagesPerSite?: number;
  useApifyProxy?: boolean;
};

export type PendingComparison = {
  pathKey: string;
  rowIndex: number;
  pair: UrlPair;
};

export type DiscoveryDiagnostics = {
  warnings: string[];
  pendingComparisons: number;
  totalPaths: number;
  useApifyProxy: boolean;
  production: {
    provider: string;
    discoveredPaths: number;
    allowedHosts: string[];
    queueSize: number;
    visitedCount: number;
    apifyRunId: string;
    apifyDatasetId: string;
  };
  staging: {
    provider: string;
    discoveredPaths: number;
    allowedHosts: string[];
    queueSize: number;
    visitedCount: number;
    apifyRunId: string;
    apifyDatasetId: string;
  };
};

function normalizePathname(pathname: string): string {
  const normalized = (pathname || "/").trim().toLowerCase();
  if (!normalized || normalized === "/") {
    return "/";
  }
  return normalized.replace(/\/+$/, "") || "/";
}

function normalizeHost(hostname: string) {
  return hostname.trim().toLowerCase();
}

function getDefaultHostAliases(hostname: string) {
  const normalized = normalizeHost(hostname);
  const aliases = new Set<string>([normalized]);
  if (normalized.startsWith("www.")) {
    aliases.add(normalized.slice(4));
  } else {
    aliases.add(`www.${normalized}`);
  }
  return Array.from(aliases);
}

function toAbsolutePathUrl(origin: string, normalizedPath: string): string {
  return new URL(normalizedPath, origin).toString();
}

function isTerminalFilePath(pathname: string): boolean {
  return NON_HTML_EXTENSION_RE.test(pathname);
}

function isExcludedDiscoveryPath(pathname: string) {
  return EXCLUDED_DISCOVERY_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

function getApifyConfig() {
  const token = process.env.APIFY_API_TOKEN?.trim();
  const actorId = process.env.APIFY_ACTOR_ID?.trim() || APIFY_DEFAULT_ACTOR;

  if (!token) {
    throw new Error("Missing APIFY_API_TOKEN");
  }

  return { token, actorId };
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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCookieHeader(cookieHeader: string, domain: string): ApifyCookie[] {
  if (!cookieHeader.trim()) {
    return [];
  }

  const cookies: ApifyCookie[] = [];
  const entries = cookieHeader.split(";");
  for (const entry of entries) {
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

function buildApifyHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function isRetryableApifyError(error: unknown) {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    if (status && [429, 502, 503, 504].includes(status)) {
      return true;
    }
    const code = error.code?.toUpperCase();
    return ["ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code ?? "");
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const normalized = error.message.toLowerCase();
  return (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("gateway") ||
    normalized.includes("econnreset")
  );
}

async function withApifyRetries<T>(task: () => Promise<T>) {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= APIFY_POLL_RETRY_COUNT) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt >= APIFY_POLL_RETRY_COUNT || !isRetryableApifyError(error)) {
        break;
      }
      attempt += 1;
      if (APIFY_POLL_RETRY_DELAY_MS > 0) {
        await delay(APIFY_POLL_RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError;
}

function describeApifyError(error: unknown) {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const responseData = error.response?.data;
    let detail = "";
    if (typeof responseData === "string" && responseData.trim()) {
      detail = responseData.trim();
    } else if (responseData && typeof responseData === "object") {
      const typed = responseData as { error?: { type?: string; message?: string }; message?: string };
      detail = typed.error?.message || typed.message || "";
    }
    const suffix = detail ? ` (${detail})` : "";
    if (status === 402) {
      return `Apify request failed with HTTP 402${suffix}`;
    }
    if (status === 401) {
      return `Apify authentication failed${suffix}`;
    }
    if (status === 403) {
      return `Apify request was forbidden${suffix}`;
    }
    if (status === 429) {
      return `Apify rate limit reached${suffix}`;
    }
    if (status) {
      return `Apify request failed with HTTP ${status}${suffix}`;
    }
    return error.message || "Unknown Apify request error";
  }

  return error instanceof Error ? error.message : "Unknown Apify error";
}

function appendWarning(state: DiscoveryJobState, message: string) {
  if (!message.trim()) {
    return;
  }
  if (state.warnings.includes(message)) {
    return;
  }
  state.warnings.push(message);
  if (state.warnings.length > 100) {
    state.warnings = state.warnings.slice(-100);
  }
}

function handleApifyFailure(state: DiscoveryJobState, side: SideKey, message: string) {
  appendWarning(state, message);
  const info = sideState(state, side);
  if (APIFY_DISCOVERY_FALLBACK_TO_LOCAL) {
    info.provider = "static";
    if (!info.queue.includes("/")) {
      info.queue.push("/");
    }
    return;
  }

  info.provider = "done";
  info.apifyFinished = true;
  appendWarning(state, `${side}: discovery stopped because local fallback is disabled`);
}

function sideState(state: DiscoveryJobState, side: SideKey): DiscoverySideState {
  return side === "production" ? state.production : state.staging;
}

function addAllowedHost(info: DiscoverySideState, hostname: string) {
  const normalized = normalizeHost(hostname);
  if (!normalized) {
    return false;
  }
  if (info.allowedHosts.includes(normalized)) {
    return false;
  }
  info.allowedHosts.push(normalized);
  return true;
}

function isAllowedHost(info: DiscoverySideState, hostname: string) {
  const normalized = normalizeHost(hostname);
  return info.allowedHosts.includes(normalized);
}

function maybeAddRedirectHostAlias(state: DiscoveryJobState, side: SideKey, candidateHost: string) {
  const info = sideState(state, side);
  if (!candidateHost.trim()) {
    return;
  }
  if (side === "staging" && isAllowedHost(state.production, candidateHost)) {
    return;
  }
  if (addAllowedHost(info, candidateHost)) {
    appendWarning(state, `${side}: added redirect host alias ${normalizeHost(candidateHost)}`);
  }
}

function maybeStopStagingDiscoveryOnRootRedirect(
  state: DiscoveryJobState,
  side: SideKey,
  redirectedHost: string,
  redirectedPath: string,
) {
  if (side !== "staging") {
    return false;
  }

  const info = sideState(state, side);
  const normalizedHost = normalizeHost(redirectedHost);
  const normalizedPath = normalizePathname(redirectedPath);
  if (!normalizedHost || normalizedPath !== info.rootPath) {
    return false;
  }

  if (isAllowedHost(info, normalizedHost)) {
    return false;
  }

  const redirectsToProduction = isAllowedHost(state.production, normalizedHost);
  if (!redirectsToProduction) {
    return false;
  }

  info.allowedHosts = getDefaultHostAliases(info.host);
  info.rootRedirectedToProduction = true;
  info.provider = "done";
  info.apifyFinished = true;
  appendWarning(
    state,
    `staging: root URL redirects to production host ${normalizedHost}; stopping staging discovery and comparing mapped staging URLs only`,
  );
  return true;
}

function discoveredCountForSide(state: DiscoveryJobState, side: SideKey) {
  let count = 0;
  for (const entry of Object.values(state.paths)) {
    const discovered = side === "production" ? entry.discoveredOnProduction : entry.discoveredOnStaging;
    if (discovered) {
      count += 1;
    }
  }
  return count;
}

function canDiscoverMoreForSide(state: DiscoveryJobState, side: SideKey) {
  return discoveredCountForSide(state, side) < state.maxPagesPerSite;
}

function updatePathForSide(state: DiscoveryJobState, side: SideKey, pathKey: string) {
  const productionUrl = toAbsolutePathUrl(state.production.origin, pathKey);
  const stagingUrl = toAbsolutePathUrl(state.staging.origin, pathKey);
  const current = state.paths[pathKey];

  if (!current) {
    state.paths[pathKey] = {
      rowIndex: state.nextRowIndex,
      productionUrl,
      stagingUrl,
      discoveredOnProduction: side === "production",
      discoveredOnStaging: side === "staging",
      needsCompare: true,
      comparedCount: 0,
    };
    state.nextRowIndex += 1;
    return;
  }

  if (side === "production") {
    if (!current.discoveredOnProduction) {
      current.discoveredOnProduction = true;
      current.needsCompare = true;
    }
    return;
  }

  if (!current.discoveredOnStaging) {
    current.discoveredOnStaging = true;
    current.needsCompare = true;
  }
}

function cacheForSide(state: DiscoveryJobState, side: SideKey) {
  if (!state.pageCache) {
    state.pageCache = {
      production: {},
      staging: {},
    };
  }
  if (!state.pageCache.production) {
    state.pageCache.production = {};
  }
  if (!state.pageCache.staging) {
    state.pageCache.staging = {};
  }
  return side === "production" ? state.pageCache.production : state.pageCache.staging;
}

function getCachedSnapshot(state: DiscoveryJobState, side: SideKey, pathKey: string) {
  return cacheForSide(state, side)[pathKey] ?? null;
}

function setCachedSnapshot(
  state: DiscoveryJobState,
  side: SideKey,
  pathKey: string,
  snapshot: DiscoveryPageSnapshot,
) {
  cacheForSide(state, side)[pathKey] = snapshot;
}

async function buildDiscoverySnapshot(
  requestedUrl: string,
  snapshot: DiscoveryPageSnapshot,
  options: { cookieHeader?: string; useApifyProxy?: boolean },
) {
  if (hasCompletePageMetadata(snapshot)) {
    return snapshot;
  }

  return repairIncompletePageData(
    {
      ...snapshot,
      requestedUrl,
    },
    {
      cookieHeader: options.cookieHeader,
      strategy: "static-only",
      useApifyProxy: options.useApifyProxy,
    },
  );
}

function extractHtmlFromApifyItem(item: unknown): string {
  if (!item || typeof item !== "object") {
    return "";
  }

  const candidate = item as Record<string, unknown>;
  return typeof candidate.html === "string" ? candidate.html : "";
}

function extractUrlFromApifyItem(item: unknown): string | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const candidate = item as Record<string, unknown>;
  const keys = ["url", "link", "requestUrl", "loadedUrl", "finalUrl", "pageUrl", "canonicalUrl"];
  for (const key of keys) {
    const value = candidate[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

async function startApifyRunIfNeeded(state: DiscoveryJobState, side: SideKey) {
  const info = sideState(state, side);
  if (info.provider !== "apify" || info.apifyRunId) {
    return;
  }

  let token: string;
  let actorId: string;
  try {
    const config = getApifyConfig();
    token = config.token;
    actorId = config.actorId;
  } catch (error) {
    handleApifyFailure(
      state,
      side,
      `${side}: apify unavailable (${error instanceof Error ? error.message : "Unknown"})`,
    );
    return;
  }

  const actorIdentifier = normalizeApifyActorIdentifier(actorId);
  const actorRunUrl = `https://api.apify.com/v2/acts/${encodeURIComponent(actorIdentifier)}/runs`;
  const initialCookies = parseCookieHeader(info.cookieHeader, info.host);

  const actorInput = {
    startUrls: [{ url: info.rootUrl }],
    crawlerType: "playwright:adaptive",
    maxCrawlDepth: 9999,
    maxCrawlPages: state.maxPagesPerSite,
    useSitemaps: true,
    respectRobotsTxtFile: false,
    keepUrlFragments: false,
    maxRequestRetries: 2,
    requestTimeoutSecs: 60,
    maxConcurrency: APIFY_MAX_CONCURRENCY,
    saveHtml: true,
    saveMarkdown: false,
    htmlTransformer: "none",
    proxyConfiguration: state.useApifyProxy ? { useApifyProxy: true } : undefined,
    initialCookies,
    customHttpHeaders: info.cookieHeader ? { Cookie: info.cookieHeader } : {},
  };

  try {
    const runResponse = await withApifyRetries(() =>
      axios.post<ApifyRunResponse>(actorRunUrl, actorInput, {
        timeout: 60_000,
        params: {
          token,
        },
        headers: buildApifyHeaders(token),
      }),
    );

    info.apifyRunId = runResponse.data?.data?.id ?? "";
    info.apifyDatasetId = runResponse.data?.data?.defaultDatasetId ?? "";
    info.apifyFinished = false;
  } catch (error) {
    handleApifyFailure(
      state,
      side,
      `${side}: apify actor run failed (${describeApifyError(error)})`,
    );
  }
}

async function abortApifyRun(runId: string) {
  if (!runId) {
    return;
  }

  const { token } = getApifyConfig();
  await axios.post<ApifyAbortResponse>(`https://api.apify.com/v2/actor-runs/${runId}/abort`, undefined, {
    timeout: REQUEST_TIMEOUT_MS,
    params: { token },
    headers: buildApifyHeaders(token),
    validateStatus: (status) => (status >= 200 && status < 300) || status === 404 || status === 409,
  });
}

export async function abortDiscoveryApifyRuns(state: DiscoveryJobState) {
  const runIds = new Set<string>();
  if (state.production.apifyRunId && !state.production.apifyFinished) {
    runIds.add(state.production.apifyRunId);
  }
  if (state.staging.apifyRunId && !state.staging.apifyFinished) {
    runIds.add(state.staging.apifyRunId);
  }

  for (const runId of runIds) {
    try {
      await abortApifyRun(runId);
    } catch {
      // Best-effort abort only.
    }
  }
}

async function pollApifySide(state: DiscoveryJobState, side: SideKey) {
  const info = sideState(state, side);
  if (info.provider !== "apify") {
    return;
  }

  await startApifyRunIfNeeded(state, side);
  if (info.provider !== "apify") {
    return;
  }

  let token: string;
  try {
    token = getApifyConfig().token;
  } catch {
    handleApifyFailure(state, side, `${side}: apify unavailable (Missing APIFY_API_TOKEN)`);
    return;
  }

  if (!info.apifyDatasetId && info.apifyRunId) {
    try {
      const runDetails = await withApifyRetries(() =>
        axios.get<ApifyRunResponse>(`https://api.apify.com/v2/actor-runs/${info.apifyRunId}`, {
          timeout: REQUEST_TIMEOUT_MS,
          params: { token },
          headers: buildApifyHeaders(token),
        }),
      );
      info.apifyDatasetId = runDetails.data?.data?.defaultDatasetId ?? "";
    } catch {
      // Ignore for now; it might be eventually available.
    }
  }

  if (info.apifyDatasetId) {
    try {
      const datasetItems = await withApifyRetries(() =>
        axios.get<unknown[]>(`https://api.apify.com/v2/datasets/${info.apifyDatasetId}/items`, {
          timeout: 60_000,
          params: {
            token,
            clean: true,
            offset: info.apifyOffset,
            limit: APIFY_DATASET_PAGE_SIZE,
          },
          headers: buildApifyHeaders(token),
        }),
      );

      const items = Array.isArray(datasetItems.data) ? datasetItems.data : [];
      for (const item of items) {
        if (!canDiscoverMoreForSide(state, side)) {
          break;
        }
        const itemUrl = extractUrlFromApifyItem(item);
        if (!itemUrl) {
          continue;
        }

        try {
          const parsed = new URL(itemUrl);
          const hostname = normalizeHost(parsed.hostname);
          const normalizedPath = normalizePathname(parsed.pathname);
          if (maybeStopStagingDiscoveryOnRootRedirect(state, side, hostname, normalizedPath)) {
            break;
          }
          if (!isAllowedHost(info, hostname)) {
            const sideDiscoveredCount = discoveredCountForSide(state, side);
            const canPromoteAsRedirectAlias =
              normalizedPath === info.rootPath || sideDiscoveredCount <= 1 || info.apifyOffset === 0;
            if (canPromoteAsRedirectAlias) {
              maybeAddRedirectHostAlias(state, side, hostname);
            }
          }

          if (!isAllowedHost(info, hostname)) {
            continue;
          }
          const pathKey = normalizedPath;
          if (isExcludedDiscoveryPath(pathKey)) {
            continue;
          }
          updatePathForSide(state, side, pathKey);
          const html = extractHtmlFromApifyItem(item);
          if (html.trim()) {
            const requestedUrl = toAbsolutePathUrl(info.origin, pathKey);
            const snapshot = parsePageDataFromApifyItem(requestedUrl, parsed.toString(), item as ApifyDatasetItem);
            setCachedSnapshot(
              state,
              side,
              pathKey,
              await buildDiscoverySnapshot(requestedUrl, snapshot, {
                cookieHeader: info.cookieHeader,
                useApifyProxy: state.useApifyProxy,
              }),
            );
          }
        } catch {
          // Ignore malformed URLs from dataset rows.
        }
      }

      info.apifyOffset += items.length;
    } catch (error) {
      appendWarning(
        state,
        `${side}: apify dataset fetch failed (${error instanceof Error ? error.message : "Unknown error"})`,
      );
    }
  }

  let runStatus = "";
  if (info.apifyRunId) {
    try {
      const runDetails = await withApifyRetries(() =>
        axios.get<ApifyRunResponse>(`https://api.apify.com/v2/actor-runs/${info.apifyRunId}`, {
          timeout: REQUEST_TIMEOUT_MS,
          params: { token },
          headers: buildApifyHeaders(token),
        }),
      );
      runStatus = (runDetails.data?.data?.status ?? "").toUpperCase();
      if (!info.apifyDatasetId) {
        info.apifyDatasetId = runDetails.data?.data?.defaultDatasetId ?? info.apifyDatasetId;
      }
    } catch (error) {
      appendWarning(state, `${side}: unable to poll apify run (${error instanceof Error ? error.message : "Unknown"})`);
    }
  }

  const isApifyTerminal = ["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(runStatus);
  if (!isApifyTerminal) {
    if (!canDiscoverMoreForSide(state, side)) {
      info.provider = "done";
      info.apifyFinished = true;
    }
    return;
  }

  info.apifyFinished = true;

  if (runStatus !== "SUCCEEDED") {
    handleApifyFailure(state, side, `${side}: apify run ended with status ${runStatus}`);
    return;
  }

  const sideCount = discoveredCountForSide(state, side);
  if (sideCount <= 1 && canDiscoverMoreForSide(state, side)) {
    handleApifyFailure(state, side, `${side}: apify run returned too few URLs`);
    return;
  }

  info.provider = "done";
}

async function processStaticSideTick(state: DiscoveryJobState, side: SideKey) {
  const info = sideState(state, side);
  if (info.provider !== "static") {
    return;
  }

  if (!canDiscoverMoreForSide(state, side)) {
    info.provider = "done";
    return;
  }

  while (info.queue.length > 0) {
    const currentPath = info.queue.shift() ?? "/";
    if (info.visited.includes(currentPath)) {
      continue;
    }
    info.visited.push(currentPath);

    if (isTerminalFilePath(currentPath)) {
      continue;
    }
    if (isExcludedDiscoveryPath(currentPath)) {
      continue;
    }

    const targetUrl = toAbsolutePathUrl(info.origin, currentPath);
    try {
      if (LOCAL_DISCOVERY_DELAY_MS > 0) {
        await delay(LOCAL_DISCOVERY_DELAY_MS);
      }
      const page = await fetchPage(targetUrl, {
        cookieHeader: info.cookieHeader,
        strategy: "static-only",
      });
      const final = new URL(page.finalUrl);
      if (maybeStopStagingDiscoveryOnRootRedirect(state, side, final.hostname, final.pathname)) {
        break;
      }
      maybeAddRedirectHostAlias(state, side, final.hostname);
      if (!isAllowedHost(info, final.hostname)) {
        continue;
      }

      const finalPath = normalizePathname(final.pathname);
      if (isExcludedDiscoveryPath(finalPath)) {
        continue;
      }
      updatePathForSide(state, side, finalPath);
      setCachedSnapshot(
        state,
        side,
        finalPath,
        await buildDiscoverySnapshot(
          targetUrl,
          {
            requestedUrl: targetUrl,
            finalUrl: page.finalUrl,
            title: page.title,
            description: page.description,
            descriptionSource: page.descriptionSource,
            metadataRenderer: page.metadataRenderer,
            html: page.html,
            usedRenderer: page.usedRenderer,
          },
          {
            cookieHeader: info.cookieHeader,
            useApifyProxy: state.useApifyProxy,
          },
        ),
      );

      const $ = load(page.html);
      const hrefs = $("a[href]")
        .toArray()
        .map((node) => ($(node).attr("href") ?? "").trim())
        .filter(Boolean);

      for (const href of hrefs) {
        if (!canDiscoverMoreForSide(state, side)) {
          break;
        }
        const absolute = resolveHref(page.finalUrl, href);
        if (!absolute) {
          continue;
        }

        let parsed: URL;
        try {
          parsed = new URL(absolute);
        } catch {
          continue;
        }

        if (!isAllowedHost(info, parsed.hostname)) {
          continue;
        }

        const normalizedPath = normalizePathname(parsed.pathname);
        if (isExcludedDiscoveryPath(normalizedPath)) {
          continue;
        }
        updatePathForSide(state, side, normalizedPath);

        if (
          !isTerminalFilePath(normalizedPath) &&
          !info.visited.includes(normalizedPath) &&
          !info.queue.includes(normalizedPath)
        ) {
          info.queue.push(normalizedPath);
        }
      }
    } catch (error) {
      appendWarning(
        state,
        `${side}: failed to crawl ${targetUrl} (${error instanceof Error ? error.message : "Unknown error"})`,
      );
    }

    break;
  }

  if (info.queue.length === 0 || !canDiscoverMoreForSide(state, side)) {
    info.provider = "done";
  }
}

export function createDiscoveryJobState(input: CreateDiscoveryStateInput): DiscoveryJobState {
  assertSafePublicUrl(input.productionRootUrl);
  assertSafePublicUrl(input.stagingRootUrl);

  const maxPages = input.maxPagesPerSite ?? MAX_DISCOVERY_PAGES_PER_SITE;
  const productionRoot = new URL(input.productionRootUrl);
  const stagingRoot = new URL(input.stagingRootUrl);
  const productionHost = normalizeHost(productionRoot.hostname);
  const stagingHost = normalizeHost(stagingRoot.hostname);
  const productionRootPath = normalizePathname(productionRoot.pathname);
  const stagingRootPath = normalizePathname(stagingRoot.pathname);

  const state: DiscoveryJobState = {
    maxPagesPerSite: maxPages,
    useApifyProxy: input.useApifyProxy ?? APIFY_USE_PROXY,
    nextRowIndex: 0,
    warnings: [],
    paths: {},
    pageCache: {
      production: {},
      staging: {},
    },
    production: {
      rootUrl: productionRoot.toString(),
      origin: productionRoot.origin,
      host: productionHost,
      rootPath: productionRootPath,
      allowedHosts: getDefaultHostAliases(productionHost),
      cookieHeader: input.productionCookieHeader ?? "",
      provider: "apify",
      apifyRunId: "",
      apifyDatasetId: "",
      apifyOffset: 0,
      apifyFinished: false,
      rootRedirectedToProduction: false,
      queue: [],
      visited: [],
    },
    staging: {
      rootUrl: stagingRoot.toString(),
      origin: stagingRoot.origin,
      host: stagingHost,
      rootPath: stagingRootPath,
      allowedHosts: getDefaultHostAliases(stagingHost),
      cookieHeader: input.stagingCookieHeader ?? "",
      provider: "apify",
      apifyRunId: "",
      apifyDatasetId: "",
      apifyOffset: 0,
      apifyFinished: false,
      rootRedirectedToProduction: false,
      queue: [],
      visited: [],
    },
  };

  updatePathForSide(state, "production", productionRootPath);
  updatePathForSide(state, "staging", stagingRootPath);
  return state;
}

export async function runDiscoveryTick(state: DiscoveryJobState): Promise<DiscoveryJobState> {
  await pollApifySide(state, "production");
  await processStaticSideTick(state, "production");
  if (state.production.provider !== "done") {
    return state;
  }

  await pollApifySide(state, "staging");
  await processStaticSideTick(state, "staging");
  return state;
}

export function getNextPendingComparison(state: DiscoveryJobState): PendingComparison | null {
  const entries = Object.entries(state.paths).sort((a, b) => a[1].rowIndex - b[1].rowIndex);
  for (const [pathKey, entry] of entries) {
    if (!entry.needsCompare) {
      continue;
    }
    return {
      pathKey,
      rowIndex: entry.rowIndex,
      pair: {
        productionUrl: entry.productionUrl,
        stagingUrl: entry.stagingUrl,
      },
    };
  }
  return null;
}

export function getDiscoveryPageSnapshot(
  state: DiscoveryJobState,
  side: SideKey,
  pathKey: string,
) {
  return getCachedSnapshot(state, side, pathKey);
}

export function markComparisonProcessed(state: DiscoveryJobState, rowIndex: number) {
  for (const entry of Object.values(state.paths)) {
    if (entry.rowIndex !== rowIndex) {
      continue;
    }
    entry.needsCompare = false;
    entry.comparedCount += 1;
    return;
  }
}

export function summarizeDiscoveryState(state: DiscoveryJobState) {
  const all = Object.values(state.paths);
  const total = all.length;
  const completed = all.filter((entry) => entry.comparedCount > 0 && !entry.needsCompare).length;
  const pending = all.filter((entry) => entry.needsCompare).length;
  return { total, completed, pending };
}

function sideDiagnostics(state: DiscoveryJobState, side: SideKey) {
  const info = sideState(state, side);
  return {
    provider: info.provider,
    discoveredPaths: discoveredCountForSide(state, side),
    allowedHosts: [...info.allowedHosts],
    queueSize: info.queue.length,
    visitedCount: info.visited.length,
    apifyRunId: info.apifyRunId,
    apifyDatasetId: info.apifyDatasetId,
  };
}

export function getDiscoveryDiagnostics(state: DiscoveryJobState): DiscoveryDiagnostics {
  const summary = summarizeDiscoveryState(state);
  return {
    warnings: [...state.warnings],
    pendingComparisons: summary.pending,
    totalPaths: summary.total,
    useApifyProxy: state.useApifyProxy,
    production: sideDiagnostics(state, "production"),
    staging: sideDiagnostics(state, "staging"),
  };
}

export function isDiscoveryComplete(state: DiscoveryJobState) {
  return state.production.provider === "done" && state.staging.provider === "done";
}
