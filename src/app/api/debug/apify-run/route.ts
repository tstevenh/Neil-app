import { NextResponse } from "next/server";
import { getRequestUserId, UnauthorizedError } from "@/lib/user";
import { APIFY_MAX_CONCURRENCY, APIFY_USE_PROXY } from "@/lib/runtime-config";

function normalizeApifyActorIdentifier(value: string) {
  if (value.includes("~")) {
    return value;
  }
  if (value.includes("/")) {
    return value.replace("/", "~");
  }
  return value;
}

async function parseJsonSafe(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readOptionalPositiveInt(value: unknown, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

function readOptionalBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
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

  const token = process.env.APIFY_API_TOKEN?.trim();
  if (!token) {
    return NextResponse.json({ error: "Missing APIFY_API_TOKEN" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const targetUrl = typeof body?.url === "string" ? body.url.trim() : "";
  if (!targetUrl) {
    return NextResponse.json({ error: "Missing url in request body" }, { status: 400 });
  }

  const maxCrawlDepth = readOptionalPositiveInt(body?.maxCrawlDepth, 2);
  const maxCrawlPages = readOptionalPositiveInt(body?.maxCrawlPages, 1);
  const maxConcurrency = readOptionalPositiveInt(body?.maxConcurrency, APIFY_MAX_CONCURRENCY);
  const useSitemaps = readOptionalBoolean(body?.useSitemaps, true);
  const useApifyProxy = readOptionalBoolean(body?.useApifyProxy, APIFY_USE_PROXY);
  const cookieHeader = typeof body?.cookieHeader === "string" ? body.cookieHeader.trim() : "";

  const actorId = process.env.APIFY_ACTOR_ID?.trim() || "apify/website-content-crawler";
  const actorIdentifier = normalizeApifyActorIdentifier(actorId);

  const actorInput = {
    startUrls: [{ url: targetUrl }],
    crawlerType: "playwright:adaptive",
    maxCrawlDepth,
    maxCrawlPages,
    useSitemaps,
    respectRobotsTxtFile: false,
    keepUrlFragments: false,
    maxRequestRetries: 2,
    requestTimeoutSecs: 60,
    maxConcurrency,
    customHttpHeaders: cookieHeader ? { Cookie: cookieHeader } : {},
    proxyConfiguration: useApifyProxy ? { useApifyProxy: true } : undefined,
  };

  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorIdentifier)}/runs?token=${token}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(actorInput),
  });

  const text = await response.text();
  const parsed = await parseJsonSafe(text);

  return NextResponse.json({
    ok: response.ok,
    status: response.status,
    actorId,
    input: actorInput,
    response: parsed,
  });
}
