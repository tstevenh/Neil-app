import { NextResponse } from "next/server";
import { load } from "cheerio";
import { fetchPage } from "@/lib/fetch-page";
import { getRequestUserId, UnauthorizedError } from "@/lib/user";

const DEBUG_KEYWORDS = [
  "site_info",
  "\"description\"",
  "\"seo\"",
  "\"meta\"",
  "yoast",
  "rank_math",
  "__next_data__",
];

function collectMetaTags(html: string) {
  const $ = load(html);
  return $("meta")
    .toArray()
    .map((node) => {
      const $node = $(node);
      return {
        name: ($node.attr("name") || "").trim(),
        property: ($node.attr("property") || "").trim(),
        content: ($node.attr("content") || "").trim(),
      };
    })
    .filter((tag) => tag.name || tag.property || tag.content);
}

function collectScriptMatches(html: string) {
  const $ = load(html);
  return $("script")
    .toArray()
    .map((node, index) => {
      const content = $(node).html() ?? "";
      if (!content.trim()) {
        return null;
      }

      const normalized = content.toLowerCase();
      const matchedKeywords = DEBUG_KEYWORDS.filter((keyword) => normalized.includes(keyword.toLowerCase()));
      if (matchedKeywords.length === 0) {
        return null;
      }

      const collapsed = content.replace(/\s+/g, " ").trim();
      return {
        index,
        type: ($(node).attr("type") || "").trim(),
        matchedKeywords,
        snippet: collapsed.slice(0, 1200),
      };
    })
    .filter(Boolean)
    .slice(0, 10);
}

function collectRawSnippets(html: string) {
  const collapsed = html.replace(/\s+/g, " ").trim();
  const snippets: Array<{ keyword: string; snippet: string }> = [];

  for (const keyword of DEBUG_KEYWORDS) {
    const index = collapsed.toLowerCase().indexOf(keyword.toLowerCase());
    if (index < 0) {
      continue;
    }

    const start = Math.max(0, index - 200);
    const end = Math.min(collapsed.length, index + 1000);
    snippets.push({
      keyword,
      snippet: collapsed.slice(start, end),
    });
  }

  return snippets.slice(0, 10);
}

export async function POST(request: Request) {
  try {
    await getRequestUserId();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const cookieHeader = typeof body?.cookieHeader === "string" ? body.cookieHeader.trim() : "";
  const strategy =
    body?.strategy === "apify-first"
      ? "apify-first"
      : body?.strategy === "static-only"
        ? "static-only"
        : "local-only";
  const useApifyProxy = typeof body?.useApifyProxy === "boolean" ? body.useApifyProxy : undefined;
  const includeDebug = body?.includeDebug === true;

  if (!url) {
    return NextResponse.json({ error: "Missing url in request body" }, { status: 400 });
  }

  try {
    const page = await fetchPage(url, {
      cookieHeader,
      strategy,
      useApifyProxy,
    });

    return NextResponse.json({
      requestedUrl: page.requestedUrl,
      finalUrl: page.finalUrl,
      title: page.title,
      description: page.description,
      descriptionSource: page.descriptionSource,
      metadataRenderer: page.metadataRenderer,
      usedRenderer: page.usedRenderer,
      htmlLength: page.html.length,
      metaTags: collectMetaTags(page.html),
      ...(includeDebug
        ? {
            scriptMatches: collectScriptMatches(page.html),
            rawSnippets: collectRawSnippets(page.html),
          }
        : {}),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown fetch error" },
      { status: 500 },
    );
  }
}
