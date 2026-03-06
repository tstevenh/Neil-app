import axios from "axios";
import { load } from "cheerio";
import { fetchPage } from "@/lib/fetch-page";
import {
  BLOCKED_RETRY_COUNT,
  BLOCKED_RETRY_DELAY_MS,
  MAX_LINKS_PER_PAGE,
  REQUEST_TIMEOUT_MS,
} from "@/lib/runtime-config";
import { assertSafePublicUrl } from "@/lib/security";
import { normalizeDedupeLink, normalizeMetaText, normalizeSlug, resolveHref } from "@/lib/url";
import type { BadLink, CompareResult, UrlPair } from "@/lib/types";

type ComparePairOptions = {
  productionCookieHeader?: string;
  stagingCookieHeader?: string;
  useApifyProxy?: boolean;
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksBlocked(title: string, html: string) {
  const normalizedTitle = (title ?? "").toLowerCase();
  const snippet = (html ?? "").slice(0, 5000).toLowerCase();
  return (
    normalizedTitle.includes("just a moment") ||
    snippet.includes("cf-browser-verification") ||
    snippet.includes("attention required") ||
    snippet.includes("captcha")
  );
}

async function fetchWithBlockedRetry(
  url: string,
  options: { cookieHeader?: string; useApifyProxy?: boolean },
) {
  let attempts = 0;
  let lastPage = await fetchPage(url, {
    cookieHeader: options.cookieHeader,
    strategy: "apify-first",
    useApifyProxy: options.useApifyProxy,
  });

  while (looksBlocked(lastPage.title, lastPage.html) && attempts < BLOCKED_RETRY_COUNT) {
    attempts += 1;
    await delay(BLOCKED_RETRY_DELAY_MS);
    lastPage = await fetchPage(url, {
      cookieHeader: options.cookieHeader,
      strategy: "apify-first",
      useApifyProxy: options.useApifyProxy,
    });
  }

  return {
    page: lastPage,
    blocked: looksBlocked(lastPage.title, lastPage.html),
    attempts,
  };
}

function computeOverallStatus(input: {
  titleMatch: boolean;
  descriptionMatch: boolean;
  slugMatch: boolean;
  brokenLinksCount: number;
  hashLinksCount: number;
}) {
  const failed =
    !input.titleMatch ||
    !input.descriptionMatch ||
    !input.slugMatch ||
    input.brokenLinksCount > 0 ||
    input.hashLinksCount > 0;
  return failed ? "FAIL" : "PASS";
}

function hasText(value: string) {
  return value.trim().length > 0;
}

async function checkLink404(url: string): Promise<number> {
  try {
    const head = await axios.head(url, {
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
    });

    if (head.status === 404 || head.status < 400) {
      return head.status;
    }
  } catch {
    // Some hosts reject HEAD; retry with GET.
  }

  const get = await axios.get(url, {
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 5,
    validateStatus: () => true,
  });

  return get.status;
}

async function analyzeProductionLinks(productionFinalUrl: string, html: string) {
  const $ = load(html);
  const anchors = $("a[href]").toArray();

  const brokenLinks: BadLink[] = [];
  const hashLinks = new Set<string>();
  const anchorLinks = new Set<string>();
  const seenNormalized = new Set<string>();

  const limitedAnchors = anchors.slice(0, MAX_LINKS_PER_PAGE);

  for (const anchor of limitedAnchors) {
    const rawHref = ($(anchor).attr("href") ?? "").trim();

    if (!rawHref) {
      continue;
    }

    if (rawHref === "#") {
      hashLinks.add(rawHref);
      continue;
    }

    if (rawHref.startsWith("#")) {
      anchorLinks.add(rawHref);
      continue;
    }

    const absolute = resolveHref(productionFinalUrl, rawHref);
    if (!absolute) {
      continue;
    }

    const dedupeKey = normalizeDedupeLink(absolute);
    if (seenNormalized.has(dedupeKey)) {
      continue;
    }
    seenNormalized.add(dedupeKey);

    try {
      const status = await checkLink404(absolute);
      if (status === 404) {
        brokenLinks.push({ url: absolute, status });
      }
    } catch {
      // MVP rule tracks only explicit 404 responses as broken.
    }
  }

  return {
    totalLinks: limitedAnchors.length,
    brokenLinks,
    hashLinks: Array.from(hashLinks),
    anchorLinks: Array.from(anchorLinks),
  };
}

export async function comparePair(pair: UrlPair, options: ComparePairOptions = {}): Promise<CompareResult> {
  const hasProduction = Boolean(pair.productionUrl);
  const hasStaging = Boolean(pair.stagingUrl);

  if (!hasProduction && !hasStaging) {
    throw new Error("At least one URL is required");
  }

  if (hasProduction) {
    assertSafePublicUrl(pair.productionUrl);
  }
  if (hasStaging) {
    assertSafePublicUrl(pair.stagingUrl);
  }

  const prodFetch = hasProduction
    ? await fetchWithBlockedRetry(pair.productionUrl, {
        cookieHeader: options.productionCookieHeader,
        useApifyProxy: options.useApifyProxy,
      })
    : null;
  const stagingFetch = hasStaging
    ? await fetchWithBlockedRetry(pair.stagingUrl, {
        cookieHeader: options.stagingCookieHeader,
        useApifyProxy: options.useApifyProxy,
      })
    : null;
  const prodPage = prodFetch?.page ?? null;
  const stagingPage = stagingFetch?.page ?? null;
  const prodBlocked = Boolean(prodFetch?.blocked);
  const stagingBlocked = Boolean(stagingFetch?.blocked);

  const prodTitle = normalizeMetaText(prodPage?.title);
  const stagingTitle = normalizeMetaText(stagingPage?.title);
  const prodDescription = normalizeMetaText(prodPage?.description);
  const stagingDescription = normalizeMetaText(stagingPage?.description);

  const titleMatch =
    hasProduction &&
    hasStaging &&
    !prodBlocked &&
    !stagingBlocked &&
    hasText(prodTitle) &&
    hasText(stagingTitle) &&
    prodTitle === stagingTitle;
  const descriptionMatch =
    hasProduction &&
    hasStaging &&
    !prodBlocked &&
    !stagingBlocked &&
    hasText(prodDescription) &&
    hasText(stagingDescription) &&
    prodDescription === stagingDescription;
  const prodSlug = prodPage ? normalizeSlug(prodPage.finalUrl) : "";
  const stagingSlug = stagingPage ? normalizeSlug(stagingPage.finalUrl) : "";
  const slugMatch = hasProduction && hasStaging && !prodBlocked && !stagingBlocked ? prodSlug === stagingSlug : false;

  const linkAnalysis = prodPage && !prodBlocked
    ? await analyzeProductionLinks(prodPage.finalUrl, prodPage.html)
    : { totalLinks: 0, brokenLinks: [], hashLinks: [], anchorLinks: [] };
  const warnings: string[] = [];

  if (!hasProduction) {
    warnings.push("Production URL is missing");
  }
  if (!hasStaging) {
    warnings.push("Staging URL is missing");
  }

  if (prodBlocked) {
    warnings.push("BLOCKED: Production blocked by bot protection");
    if ((prodFetch?.attempts ?? 0) > 0) {
      warnings.push(`Production retried ${prodFetch?.attempts}x but remained blocked`);
    }
  }
  if (stagingBlocked) {
    warnings.push("BLOCKED: Staging blocked by bot protection");
    if ((stagingFetch?.attempts ?? 0) > 0) {
      warnings.push(`Staging retried ${stagingFetch?.attempts}x but remained blocked`);
    }
  }

  if ((hasProduction || hasStaging) && (!prodTitle || !stagingTitle) && !prodBlocked && !stagingBlocked) {
    if (!prodTitle) {
      warnings.push("Missing production title");
    }
    if (!stagingTitle) {
      warnings.push("Missing staging title");
    }
  }

  if (
    (hasProduction || hasStaging) &&
    (!prodDescription || !stagingDescription) &&
    !prodBlocked &&
    !stagingBlocked
  ) {
    if (!prodDescription) {
      warnings.push("Missing production meta description");
    }
    if (!stagingDescription) {
      warnings.push("Missing staging meta description");
    }
  }
  if (hasProduction && prodBlocked) {
    warnings.push("Skipped production 404/# link checks because page is blocked");
  }

  const brokenLinksCount = linkAnalysis.brokenLinks.length;
  const hashLinksCount = linkAnalysis.hashLinks.length;

  if (hasProduction && hasStaging && !prodBlocked && !stagingBlocked) {
    if (!titleMatch) {
      warnings.push(`Title mismatch (production: "${prodTitle || "Missing"}" | staging: "${stagingTitle || "Missing"}")`);
    }
    if (!descriptionMatch) {
      warnings.push(
        `Meta description mismatch (production: "${prodDescription || "Missing"}" | staging: "${stagingDescription || "Missing"}")`,
      );
    }
    if (!slugMatch) {
      warnings.push(`URL slug mismatch (production: "${prodSlug || "Missing"}" | staging: "${stagingSlug || "Missing"}")`);
    }
  }

  if (brokenLinksCount > 0) {
    const list = linkAnalysis.brokenLinks.slice(0, 10).map((item) => item.url).join(" | ");
    warnings.push(`404 links found: ${brokenLinksCount}${list ? ` | ${list}` : ""}`);
  }
  if (hashLinksCount > 0) {
    const list = linkAnalysis.hashLinks.slice(0, 15).join(" | ");
    warnings.push(`# links found: ${hashLinksCount}${list ? ` | ${list}` : ""}`);
  }

  return {
    productionUrl: pair.productionUrl,
    stagingUrl: pair.stagingUrl,
    finalProductionUrl: prodPage?.finalUrl ?? "",
    finalStagingUrl: stagingPage?.finalUrl ?? "",
    prodTitle,
    stagingTitle,
    titleMatch,
    prodDescription,
    stagingDescription,
    descriptionMatch,
    prodSlug,
    stagingSlug,
    slugMatch,
    totalLinks: linkAnalysis.totalLinks,
    brokenLinksCount,
    hashLinksCount,
    anchorLinksCount: linkAnalysis.anchorLinks.length,
    brokenLinks: linkAnalysis.brokenLinks,
    hashLinks: linkAnalysis.hashLinks,
    warnings,
    overallStatus: computeOverallStatus({
      titleMatch,
      descriptionMatch,
      slugMatch,
      brokenLinksCount,
      hashLinksCount,
    }),
  };
}
