import { z } from "zod";

const MAX_CSV_ROWS = 150;

export const urlPairSchema = z.object({
  productionUrl: z.url({ protocol: /^https?$/ }),
  stagingUrl: z.url({ protocol: /^https?$/ }),
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
