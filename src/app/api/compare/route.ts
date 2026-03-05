import { NextResponse } from "next/server";
import { createRun } from "@/lib/run-store";
import { getRequestUserId, UnauthorizedError } from "@/lib/user";
import { validateUrlPair } from "@/lib/validation";

export async function POST(request: Request) {
  try {
    const input = await request.json();
    const pair = validateUrlPair(input);
    const userId = await getRequestUserId();
    const run = await createRun(userId, [pair]);

    return NextResponse.json({
      runId: run.id,
      status: run.status,
      total: run.total,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
