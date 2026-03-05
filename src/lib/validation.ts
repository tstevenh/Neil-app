import { z } from "zod";
import { MAX_CSV_ROWS } from "@/lib/runtime-config";

function isValidHttpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const optionalHttpUrl = z
  .string()
  .trim()
  .default("")
  .refine((value) => value === "" || isValidHttpUrl(value), {
    message: "Invalid URL. Use http:// or https://",
  });

export const urlPairSchema = z
  .object({
    productionUrl: optionalHttpUrl,
    stagingUrl: optionalHttpUrl,
  })
  .refine((value) => Boolean(value.productionUrl) || Boolean(value.stagingUrl), {
    message: "At least one URL is required",
  });

export const bulkSchema = z.object({
  pairs: z.array(urlPairSchema).min(1).max(MAX_CSV_ROWS),
});

export function getMaxCsvRows() {
  return MAX_CSV_ROWS;
}

export function validateUrlPair(input: unknown) {
  return urlPairSchema.parse(input);
}

export function validateBulkPairs(input: unknown) {
  return bulkSchema.parse(input);
}
