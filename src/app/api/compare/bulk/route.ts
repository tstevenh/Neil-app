import { NextResponse } from "next/server";
import { parsePairsCsv } from "@/lib/csv";
import { createRun } from "@/lib/run-store";
import { getRequestUserId, UnauthorizedError } from "@/lib/user";
import { validateBulkPairs } from "@/lib/validation";

export async function POST(request: Request) {
  try {
    const userId = await getRequestUserId();
    const contentType = request.headers.get("content-type") ?? "";

    let pairs;
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        throw new Error("Missing CSV file in form-data field 'file'");
      }

      const content = await file.text();
      pairs = parsePairsCsv(content);
    } else {
      const input = await request.json();
      pairs = validateBulkPairs(input).pairs;
    }

    const run = await createRun(userId, pairs);

    return NextResponse.json({
      runId: run.id,
      status: run.status,
      total: run.total,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    const message = error instanceof Error ? error.message : "Invalid bulk request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
