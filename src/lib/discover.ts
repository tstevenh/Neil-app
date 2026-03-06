import axios from "axios";
import { load } from "cheerio";
import { fetchPage } from "@/lib/fetch-page";
import {
  APIFY_MAX_CONCURRENCY,
  APIFY_USE_PROXY,
  MAX_DISCOVERY_PAGES_PER_SITE,
  PLAYWRIGHT_DISCOVERY_DELAY_MS,
  REQUEST_TIMEOUT_MS,
} from "@/lib/runtime-config";
import { assertSafePublicUrl } from "@/lib/security";
import type { UrlPair } from "@/lib/types";
import { resolveHref } from "@/lib/url";

const NON_HTML_EXTENSION_RE = /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|bmp|tiff|mp4|mp3|wav|zip|rar|7z|gz|tar|xml|json|txt|css|js)$/i;
const APIFY_DEFAULT_ACTOR = "apify/website-content-crawler";
const APIFY_DATASET_PAGE_SIZE = 100;

type SideKey = "production" | "staging";
type SideProvider = "apify" | "playwright" | "done";

type ApifyRunResponse = {
  data?: {
    id?: string;
    defaultDatasetId?: string;
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
  if (addAllowedHost(info, candidateHost)) {
    appendWarning(state, `${side}: added redirect host alias ${normalizeHost(candidateHost)}`);
  }
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
    appendWarning(state, `${side}: apify unavailable (${error instanceof Error ? error.message : "Unknown"})`);
    info.provider = "playwright";
    if (!info.queue.includes("/")) {
      info.queue.push("/");
    }
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
    proxyConfiguration: state.useApifyProxy ? { useApifyProxy: true } : undefined,
    initialCookies,
    customHttpHeaders: info.cookieHeader ? { Cookie: info.cookieHeader } : {},
  };

  try {
    const runResponse = await axios.post<ApifyRunResponse>(actorRunUrl, actorInput, {
      timeout: 60_000,
      params: {
        token,
      },
      headers: buildApifyHeaders(token),
    });

    info.apifyRunId = runResponse.data?.data?.id ?? "";
    info.apifyDatasetId = runResponse.data?.data?.defaultDatasetId ?? "";
    info.apifyFinished = false;
  } catch (error) {
    appendWarning(
      state,
      `${side}: apify actor run failed (${error instanceof Error ? error.message : "Unknown error"})`,
    );
    info.provider = "playwright";
    if (!info.queue.includes("/")) {
      info.queue.push("/");
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
    info.provider = "playwright";
    if (!info.queue.includes("/")) {
      info.queue.push("/");
    }
    return;
  }

  if (!info.apifyDatasetId && info.apifyRunId) {
    try {
      const runDetails = await axios.get<ApifyRunResponse>(`https://api.apify.com/v2/actor-runs/${info.apifyRunId}`, {
        timeout: REQUEST_TIMEOUT_MS,
        params: { token },
        headers: buildApifyHeaders(token),
      });
      info.apifyDatasetId = runDetails.data?.data?.defaultDatasetId ?? "";
    } catch {
      // Ignore for now; it might be eventually available.
    }
  }

  if (info.apifyDatasetId) {
    try {
      const datasetItems = await axios.get<unknown[]>(`https://api.apify.com/v2/datasets/${info.apifyDatasetId}/items`, {
        timeout: 60_000,
        params: {
          token,
          clean: true,
          offset: info.apifyOffset,
          limit: APIFY_DATASET_PAGE_SIZE,
        },
        headers: buildApifyHeaders(token),
      });

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
          updatePathForSide(state, side, pathKey);
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
      const runDetails = await axios.get<ApifyRunResponse>(`https://api.apify.com/v2/actor-runs/${info.apifyRunId}`, {
        timeout: REQUEST_TIMEOUT_MS,
        params: { token },
        headers: buildApifyHeaders(token),
      });
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
    appendWarning(state, `${side}: apify run ended with status ${runStatus}`);
    info.provider = "playwright";
    if (!info.queue.includes("/")) {
      info.queue.push("/");
    }
    return;
  }

  const sideCount = discoveredCountForSide(state, side);
  if (sideCount <= 1 && canDiscoverMoreForSide(state, side)) {
    info.provider = "playwright";
    if (!info.queue.includes("/")) {
      info.queue.push("/");
    }
    return;
  }

  info.provider = "done";
}

async function processPlaywrightSideTick(state: DiscoveryJobState, side: SideKey) {
  const info = sideState(state, side);
  if (info.provider !== "playwright") {
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

    const targetUrl = toAbsolutePathUrl(info.origin, currentPath);
    try {
      if (PLAYWRIGHT_DISCOVERY_DELAY_MS > 0) {
        await delay(PLAYWRIGHT_DISCOVERY_DELAY_MS);
      }
      const page = await fetchPage(targetUrl, { cookieHeader: info.cookieHeader });
      const final = new URL(page.finalUrl);
      maybeAddRedirectHostAlias(state, side, final.hostname);
      if (!isAllowedHost(info, final.hostname)) {
        continue;
      }

      const finalPath = normalizePathname(final.pathname);
      updatePathForSide(state, side, finalPath);

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
  await pollApifySide(state, "staging");
  await processPlaywrightSideTick(state, "production");
  await processPlaywrightSideTick(state, "staging");
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
