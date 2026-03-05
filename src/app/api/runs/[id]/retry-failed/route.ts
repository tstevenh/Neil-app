import { NextResponse } from "next/server";
import { retryFailedRows } from "@/lib/run-store";
import { getRequestUserId, UnauthorizedError } from "@/lib/user";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await getRequestUserId();
    const { id } = await context.params;
    const run = await retryFailedRows(userId, id);

    if (!run) {
      return NextResponse.json({ error: "No failed rows available to retry" }, { status: 400 });
    }

    return NextResponse.json({
      runId: run.id,
      status: run.status,
      total: run.total,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }

    const message = error instanceof Error ? error.message : "Failed to retry failed rows";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
