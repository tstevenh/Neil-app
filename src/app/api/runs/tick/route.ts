import { NextResponse } from "next/server";
import { tickRunsByUser } from "@/lib/run-store";
import { getRequestUserId, UnauthorizedError } from "@/lib/user";

export async function POST() {
  try {
    const userId = await getRequestUserId();
    const runs = await tickRunsByUser(userId);
    return NextResponse.json({ runs });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "Failed to tick runs";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
