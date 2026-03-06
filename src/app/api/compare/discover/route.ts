import { NextResponse } from "next/server";
import { createDiscoveryRun } from "@/lib/run-store";
import { getRequestUserId, UnauthorizedError } from "@/lib/user";
import { validateDiscoverInput } from "@/lib/validation";

export async function POST(request: Request) {
  try {
    const userId = await getRequestUserId();
    const input = validateDiscoverInput(await request.json());

    const run = await createDiscoveryRun(userId, {
      productionRootUrl: input.productionRootUrl,
      stagingRootUrl: input.stagingRootUrl,
      productionCookieHeader: input.productionCookieHeader,
      stagingCookieHeader: input.stagingCookieHeader,
      useApifyProxy: input.useApifyProxy,
    });

    return NextResponse.json({
      runId: run.id,
      status: run.status,
      total: run.total,
      mode: "discover_stream",
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    const message = error instanceof Error ? error.message : "Invalid discover request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
