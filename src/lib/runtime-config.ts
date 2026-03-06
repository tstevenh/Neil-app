function parseIntEnv(
  value: string | undefined,
  fallback: number,
  options: { min?: number; max?: number } = {},
) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }

  const min = options.min ?? Number.NEGATIVE_INFINITY;
  const max = options.max ?? Number.POSITIVE_INFINITY;
  if (parsed < min || parsed > max) {
    return fallback;
  }

  return parsed;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export const REQUEST_TIMEOUT_MS = parseIntEnv(process.env.DEFAULT_REQUEST_TIMEOUT_MS, 10_000, {
  min: 1_000,
  max: 60_000,
});

export const MAX_LINKS_PER_PAGE = parseIntEnv(process.env.DEFAULT_MAX_LINKS_PER_PAGE, 50, {
  min: 1,
  max: 2_000,
});

export const MAX_CSV_ROWS = parseIntEnv(process.env.DEFAULT_MAX_CSV_ROWS, 150, {
  min: 1,
  max: 10_000,
});

export const MAX_RUNNING_RUNS_PER_USER = parseIntEnv(
  process.env.DEFAULT_MAX_CONCURRENT_RUNS_PER_USER,
  1,
  {
    min: 1,
    max: 5,
  },
);

export const ROW_PACING_DELAY_MS = parseIntEnv(process.env.DEFAULT_ROW_PACING_DELAY_MS, 1200, {
  min: 0,
  max: 20_000,
});

export const MAX_DISCOVERY_PAGES_PER_SITE = parseIntEnv(process.env.DEFAULT_MAX_DISCOVERY_PAGES_PER_SITE, 300, {
  min: 10,
  max: 2_000,
});

export const FETCH_PAGE_NAVIGATION_DELAY_MS = parseIntEnv(process.env.DEFAULT_FETCH_PAGE_NAV_DELAY_MS, 700, {
  min: 0,
  max: 10_000,
});

export const BLOCKED_RETRY_COUNT = parseIntEnv(process.env.DEFAULT_BLOCKED_RETRY_COUNT, 2, {
  min: 0,
  max: 10,
});

export const BLOCKED_RETRY_DELAY_MS = parseIntEnv(process.env.DEFAULT_BLOCKED_RETRY_DELAY_MS, 3000, {
  min: 0,
  max: 30_000,
});

export const PLAYWRIGHT_DISCOVERY_DELAY_MS = parseIntEnv(process.env.DEFAULT_PLAYWRIGHT_DISCOVERY_DELAY_MS, 900, {
  min: 0,
  max: 15_000,
});

export const APIFY_MAX_CONCURRENCY = parseIntEnv(process.env.DEFAULT_APIFY_MAX_CONCURRENCY, 4, {
  min: 1,
  max: 50,
});

export const APIFY_USE_PROXY = parseBooleanEnv(process.env.DEFAULT_APIFY_USE_PROXY, true);

export const APIFY_COMPARE_FETCH_ENABLED = parseBooleanEnv(process.env.DEFAULT_APIFY_COMPARE_FETCH_ENABLED, true);

export const APIFY_COMPARE_FALLBACK_TO_LOCAL = parseBooleanEnv(
  process.env.DEFAULT_APIFY_COMPARE_FALLBACK_TO_LOCAL,
  true,
);

export const APIFY_COMPARE_TIMEOUT_MS = parseIntEnv(process.env.DEFAULT_APIFY_COMPARE_TIMEOUT_MS, 120_000, {
  min: 5_000,
  max: 300_000,
});
