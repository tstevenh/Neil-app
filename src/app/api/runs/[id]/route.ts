import { NextResponse } from "next/server";
import { getRunById } from "@/lib/run-store";
import { getRequestUserId, UnauthorizedError } from "@/lib/user";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const userId = await getRequestUserId();
    const { id } = await context.params;
    const run = await getRunById(id);

    if (!run || run.userId !== userId) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }

    return NextResponse.json(run);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "Failed to fetch run";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
