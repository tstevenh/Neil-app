import { z } from "zod";
import { APIFY_USE_PROXY, MAX_CSV_ROWS } from "@/lib/runtime-config";

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

export const discoverSchema = z.object({
  productionRootUrl: z
    .string()
    .trim()
    .refine((value) => isValidHttpUrl(value), {
      message: "Invalid production URL. Use http:// or https://",
    }),
  stagingRootUrl: z
    .string()
    .trim()
    .refine((value) => isValidHttpUrl(value), {
      message: "Invalid staging URL. Use http:// or https://",
    }),
  productionCookieHeader: z.string().trim().optional().default(""),
  stagingCookieHeader: z.string().trim().optional().default(""),
  useApifyProxy: z.boolean().optional().default(APIFY_USE_PROXY),
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

export function validateDiscoverInput(input: unknown) {
  if (!process.env.APIFY_API_TOKEN?.trim()) {
    throw new Error("Missing APIFY_API_TOKEN");
  }
  return discoverSchema.parse(input);
}
