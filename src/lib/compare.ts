import axios from "axios";
import { load } from "cheerio";
import { fetchPage } from "@/lib/fetch-page";
import { assertSafePublicUrl } from "@/lib/security";
import { normalizeDedupeLink, normalizeMetaText, normalizeSlug, resolveHref } from "@/lib/url";
import type { BadLink, CompareResult, UrlPair } from "@/lib/types";

const MAX_LINKS_PER_PAGE = 200;
const REQUEST_TIMEOUT_MS = 10_000;

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

export async function comparePair(pair: UrlPair): Promise<CompareResult> {
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

  const prodPage = hasProduction ? await fetchPage(pair.productionUrl) : null;
  const stagingPage = hasStaging ? await fetchPage(pair.stagingUrl) : null;

  const prodTitle = normalizeMetaText(prodPage?.title);
  const stagingTitle = normalizeMetaText(stagingPage?.title);
  const prodDescription = normalizeMetaText(prodPage?.description);
  const stagingDescription = normalizeMetaText(stagingPage?.description);

  const titleMatch = hasProduction && hasStaging ? prodTitle === stagingTitle : false;
  const descriptionMatch =
    hasProduction && hasStaging ? prodDescription === stagingDescription : false;
  const prodSlug = prodPage ? normalizeSlug(prodPage.finalUrl) : "";
  const stagingSlug = stagingPage ? normalizeSlug(stagingPage.finalUrl) : "";
  const slugMatch = hasProduction && hasStaging ? prodSlug === stagingSlug : false;

  const linkAnalysis = prodPage
    ? await analyzeProductionLinks(prodPage.finalUrl, prodPage.html)
    : { totalLinks: 0, brokenLinks: [], hashLinks: [], anchorLinks: [] };
  const warnings: string[] = [];

  if (!hasProduction) {
    warnings.push("Production URL is missing");
  }
  if (!hasStaging) {
    warnings.push("Staging URL is missing");
  }

  if ((hasProduction || hasStaging) && (!prodTitle || !stagingTitle)) {
    warnings.push("Missing title on one or both pages");
  }

  if ((hasProduction || hasStaging) && (!prodDescription || !stagingDescription)) {
    warnings.push("Missing description on one or both pages");
  }

  const brokenLinksCount = linkAnalysis.brokenLinks.length;
  const hashLinksCount = linkAnalysis.hashLinks.length;

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
