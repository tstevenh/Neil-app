import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function GET() {
  const assetPath = join(process.cwd(), "public", "digirx-logo.svg");
  const svg = await readFile(assetPath, "utf8");

  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
