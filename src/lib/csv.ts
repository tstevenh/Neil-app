import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import type { CompareResult, UrlPair } from "@/lib/types";
import { getMaxCsvRows } from "@/lib/validation";

export function parsePairsCsv(content: string): UrlPair[] {
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];

  if (rows.length > getMaxCsvRows()) {
    throw new Error(`CSV exceeds max rows (${getMaxCsvRows()})`);
  }

  const pairs: UrlPair[] = [];

  for (const row of rows) {
    const productionUrl =
      row.production_url ?? row.productionUrl ?? row["Production URL"];
    const stagingUrl = row.staging_url ?? row.stagingUrl ?? row["Staging URL"];

    const rawProd = (productionUrl ?? "").trim();
    const rawStaging = (stagingUrl ?? "").trim();

    const prod = rawProd.toLowerCase() === "missing" ? "" : rawProd;
    const staging = rawStaging.toLowerCase() === "missing" ? "" : rawStaging;

    if (!prod && !staging) {
      continue;
    }

    pairs.push({ productionUrl: prod, stagingUrl: staging });
  }

  if (pairs.length === 0) {
    throw new Error("No valid URL pairs found in CSV");
  }

  return pairs;
}

export function buildResultsCsv(results: CompareResult[]): string {
  const clean = (value: string | undefined | null) =>
    (value ?? "")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const displayOrMissing = (value: string | undefined | null) => {
    const normalized = clean(value);
    return normalized ? normalized : "Missing";
  };

  const urlMatchText = (item: CompareResult) => {
    if (!clean(item.productionUrl)) {
      return "URL not available in Production";
    }
    if (!clean(item.stagingUrl)) {
      return "URL not available in Staging";
    }
    return item.slugMatch ? "YES" : "NO";
  };

  const buildNotes = (item: CompareResult) => {
    const notes: string[] = [];

    if (!clean(item.productionUrl)) {
      notes.push("URL not available in Production");
    }
    if (!clean(item.stagingUrl)) {
      notes.push("URL not available in Staging");
    }

    if (!item.titleMatch && clean(item.productionUrl) && clean(item.stagingUrl)) {
      notes.push("Title mismatch");
    }
    if (!item.descriptionMatch && clean(item.productionUrl) && clean(item.stagingUrl)) {
      notes.push("Meta description mismatch");
    }
    if (!clean(item.prodTitle)) {
      notes.push("Missing production title");
    }
    if (!clean(item.stagingTitle)) {
      notes.push("Missing staging title");
    }
    if (!clean(item.prodDescription)) {
      notes.push("Missing production meta description");
    }
    if (!clean(item.stagingDescription)) {
      notes.push("Missing staging meta description");
    }
    if (item.brokenLinksCount > 0) {
      notes.push(
        `404 URLs: ${item.brokenLinks.map((link) => clean(link.url)).filter(Boolean).join(" | ")}`,
      );
    }
    if (item.hashLinksCount > 0) {
      notes.push(
        `# URLs: ${item.hashLinks.map((link) => clean(link)).filter(Boolean).join(" | ")}`,
      );
    }
    if (item.error) {
      notes.push(`Error: ${clean(item.error)}`);
    }

    return notes.join("; ");
  };

  return stringify(
    results.map((item) => ({
      "Production URL": displayOrMissing(item.productionUrl),
      "Staging URL": displayOrMissing(item.stagingUrl),
      "Title (Prod)": displayOrMissing(item.prodTitle),
      "Title (Staging)": displayOrMissing(item.stagingTitle),
      "Meta Desc (Prod)": displayOrMissing(item.prodDescription),
      "Meta Desc (Staging)": displayOrMissing(item.stagingDescription),
      "URL Match?": urlMatchText(item),
      "404 Links Found": item.brokenLinksCount,
      "# Links Found": item.hashLinksCount,
      Notes: buildNotes(item),
    })),
    {
      header: true,
    },
  );
}
