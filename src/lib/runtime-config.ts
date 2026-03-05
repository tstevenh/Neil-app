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
