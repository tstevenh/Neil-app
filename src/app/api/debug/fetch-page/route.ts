import { NextResponse } from "next/server";
import { load } from "cheerio";
import { fetchPage } from "@/lib/fetch-page";
import { getRequestUserId, UnauthorizedError } from "@/lib/user";

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
  const strategy = body?.strategy === "apify-first" ? "apify-first" : "local-only";
  const useApifyProxy = typeof body?.useApifyProxy === "boolean" ? body.useApifyProxy : undefined;

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
      metaTags: collectMetaTags(page.html),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown fetch error" },
      { status: 500 },
    );
  }
}
