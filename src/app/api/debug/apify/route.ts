import { NextResponse } from "next/server";
import { getRequestUserId, UnauthorizedError } from "@/lib/user";
import {
  APIFY_COMPARE_FALLBACK_TO_LOCAL,
  APIFY_COMPARE_FETCH_ENABLED,
  APIFY_DISCOVERY_FALLBACK_TO_LOCAL,
  APIFY_USE_PROXY,
} from "@/lib/runtime-config";

async function fetchApifyUserId(token: string) {
  const response = await fetch(`https://api.apify.com/v2/users/me?token=${token}`, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  return {
    ok: response.ok,
    status: response.status,
    data: body?.data,
    error: body?.error,
  };
}

export async function GET() {
  try {
    await getRequestUserId();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = process.env.APIFY_API_TOKEN?.trim() ?? "";
  const tokenTail = token ? token.slice(-6) : "";
  const actorId = process.env.APIFY_ACTOR_ID?.trim() || "apify/website-content-crawler";

  let apifyUserId: string | null = null;
  let apifyError: unknown = null;
  let apifyStatus: number | null = null;

  if (token) {
    const result = await fetchApifyUserId(token);
    apifyStatus = result.status;
    if (result.ok && result.data?.id) {
      apifyUserId = result.data.id;
    } else {
      apifyError = result.error || { message: "Unknown Apify error" };
    }
  }

  return NextResponse.json({
    apifyTokenPresent: Boolean(token),
    apifyTokenTail: tokenTail || null,
    apifyActorId: actorId,
    apifyUserId,
    apifyStatus,
    apifyError,
    apifyUseProxyDefault: APIFY_USE_PROXY,
    apifyCompareFetchEnabled: APIFY_COMPARE_FETCH_ENABLED,
    apifyCompareFallbackToLocal: APIFY_COMPARE_FALLBACK_TO_LOCAL,
    apifyDiscoveryFallbackToLocal: APIFY_DISCOVERY_FALLBACK_TO_LOCAL,
  });
}
