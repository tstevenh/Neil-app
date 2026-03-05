import { NextResponse } from "next/server";
import { cancelRun } from "@/lib/run-store";
import { getRequestUserId, UnauthorizedError } from "@/lib/user";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await getRequestUserId();
    const { id } = await context.params;
    const run = await cancelRun(userId, id);

    if (!run) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }

    return NextResponse.json({
      id: run.id,
      status: run.status,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    const message = error instanceof Error ? error.message : "Failed to cancel run";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
