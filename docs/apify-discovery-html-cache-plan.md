# Apify Discovery HTML Cache Plan

## Purpose

This document captures the next architectural step for the Meta & URL QA Checker:

- keep Apify for homepage discovery
- stop paying the full cost of re-fetching each row during compare
- reuse discovery output for compare wherever possible
- reserve live fetches for exception paths only

This is intended as a durable implementation plan so the work can continue cleanly after session compaction.

## Current State

The app currently does three different kinds of crawl/fetch work:

1. Discovery:
   - homepage crawl uses Apify to discover URLs for production and staging
   - discovery stores `apifyRunId`, `apifyDatasetId`, discovered path state, warnings, and compare queue state

2. Compare:
   - each row compare currently fetches production and staging page content again
   - compare uses `fetchPage(..., strategy: "apify-first")`
   - that can invoke Apify per row for HTML fetch

3. Link check:
   - production link checks run from the production HTML fetched during compare

### Why This Is Expensive

The current design double-spends:

- Apify discovery crawl finds the pages
- compare then re-fetches those same pages again

That creates:

- extra Apify cost
- longer runtime
- more chances to hit Apify 402/429/502 conditions
- more drift between discovery state and compare state

## Problems Observed So Far

### 1. Discovery and compare are decoupled too aggressively

Discovery may have enough information to compare, but compare starts a new fetch path anyway.

### 2. Compare is still too dependent on per-row fetches

Each compare row can fail because of:

- transient Apify 502/503/504
- 402 billing/plan/resource limits
- redirect weirdness
- timing issues

That creates blanket `Comparison failed` rows even when discovery already succeeded.

### 3. The server is a poor fit for browser-heavy fallback

Cloudways box is small.

Playwright fallback can:

- spike CPU and RAM
- trigger Nginx 504s
- make the app look unstable

### 4. Discovery already has most of the structure we need

Apify discovery gives us:

- run ID
- dataset ID
- discovered URLs and final URLs

With a small extension, it can also provide:

- HTML snapshot for each discovered page
- parsed metadata cache for compare

## Architectural Direction

### Decision

Move from:

- `discover pages -> refetch pages for compare`

To:

- `discover pages with HTML -> compare from discovery cache -> fetch only when needed`

### Target Compare Priority

For homepage crawl mode:

1. Read compare data from discovery cache
2. If cache missing for a row, use static fetch
3. If static fetch is insufficient and explicit fallback is enabled, use Playwright or Apify

For direct single compare / bulk compare mode:

1. Static fetch first
2. Playwright fallback if explicitly enabled
3. Apify compare only as optional last resort or explicit mode

This keeps Apify where it makes the most sense:

- discovery

And reduces its use where it is most expensive:

- per-row compare

## High-Level Target Design

### Discovery Output Model

Extend discovery so each side can store per-path page data:

- requested URL
- final URL
- HTML
- title
- meta description
- description source
- metadata renderer/source

Suggested shape:

```ts
type DiscoveryPageSnapshot = {
  requestedUrl: string;
  finalUrl: string;
  html: string;
  title: string;
  description: string;
  descriptionSource: "meta:description" | "none";
  metadataRenderer: "apify" | "static" | "playwright";
};
```

Suggested state addition:

```ts
type DiscoveryJobState = {
  ...
  pageCache: {
    production: Record<string, DiscoveryPageSnapshot>;
    staging: Record<string, DiscoveryPageSnapshot>;
  };
};
```

Key the cache by normalized path, not final URL, because compare rows are already path-based.

### Compare Input Model

When `run_mode === "discover_stream"` and a row is ready:

1. read production snapshot from discovery cache
2. read staging snapshot from discovery cache
3. if both exist, compare from cache only
4. if one side is missing, fetch only the missing side

This avoids redundant network work.

### Link Checking

Production link checking should use cached production HTML when available.

That removes another redundant fetch.

## Implementation Plan

## Phase 1: Discovery Cache Foundation

### Goal

Teach discovery to save HTML and parsed metadata for discovered pages.

### Files

- `src/lib/discover.ts`
- possibly `src/lib/fetch-page.ts`
- `src/lib/types.ts` if new shared types are needed

### Changes

1. Add `DiscoveryPageSnapshot` type
2. Add `pageCache.production` and `pageCache.staging` to discovery state
3. During discovery item processing:
   - if Apify dataset row includes HTML, parse and store snapshot
   - if discovery path came from non-HTML item or missing HTML, still store URL-only state
4. Ensure cache stays bounded by `maxPagesPerSite`

### Key technical detail

Discovery currently extracts URLs from dataset items using:

- `url`
- `link`
- `requestUrl`
- `loadedUrl`
- `finalUrl`
- `pageUrl`
- `canonicalUrl`

That should be extended to also read HTML fields if present.

If the Apify Website Content Crawler dataset does not reliably return HTML with current input, adjust discovery actor input to save HTML for dataset items.

### Validation

For one run, inspect discovery diagnostics and confirm:

- URLs still discover correctly
- page cache gets populated for common HTML pages

## Phase 2: Compare From Cache First

### Goal

Make discovery-mode compare consume cached page snapshots before trying any live fetch.

### Files

- `src/lib/run-store.ts`
- `src/lib/compare.ts`

### Changes

1. Add a compare entry point that accepts prefetched page data:

```ts
comparePairFromPageData(...)
```

or a hybrid API:

```ts
comparePair(pair, {
  prefetchedProductionPage,
  prefetchedStagingPage,
  ...
})
```

2. In `processDiscoveryRunTick`:
   - when a pending comparison is selected, try to read both snapshots from cache
   - if both exist, compare immediately
   - if one side missing, fetch only the missing side

3. Use cached production HTML for link analysis when present

### Validation

On a fresh run:

- discovery should still finish
- compare should no longer spawn per-row Apify compare fetches for cached pages
- total runtime and Apify usage should drop

## Phase 3: Make Compare Strategy Static-First

### Goal

Reduce server cost and Apify dependency for non-discovery compare work.

### Files

- `src/lib/fetch-page.ts`
- `src/lib/compare.ts`
- `src/lib/runtime-config.ts`

### Changes

Introduce an explicit compare fetch policy:

- `static-first`
- `apify-first`
- `local-only`

Recommended default for compare:

- static first
- Playwright fallback only if enabled
- Apify compare only as explicit override

Possible config:

```env
DEFAULT_COMPARE_FETCH_STRATEGY=static-first
DEFAULT_COMPARE_PLAYWRIGHT_FALLBACK=true|false
DEFAULT_COMPARE_APIFY_FALLBACK=true|false
```

This is separate from discovery.

### Why

Static fetch:

- is cheap on the server
- avoids Apify per-row cost
- avoids most Cloudways resource spikes

### Validation

Run:

- one single compare
- one bulk compare
- one discovery compare

Confirm:

- static compare works on ordinary HTML pages
- only genuinely difficult pages need fallback

## Phase 4: Preserve Redirect Safety

### Goal

Keep the staging-root redirect safeguard fully intact after cache changes.

### Files

- `src/lib/discover.ts`

### Rules

1. If staging root redirects to production host:
   - stop staging discovery
   - do not promote production host into staging allowed hosts
   - continue compare using mapped staging URLs only

2. If later staging page URLs redirect to production:
   - do not treat those as staging discovery wins
   - optionally store warning on row/page snapshot

### Validation

Use a staging URL that redirects on root but not on some subpaths.

Expected:

- root redirect warning appears
- production host is not adopted as staging crawl host
- compare still tries mapped staging URLs

## Phase 5: Better Failure Semantics

### Goal

Make row and run failures more truthful.

### Files

- `src/lib/run-store.ts`
- `src/lib/compare.ts`

### Changes

Differentiate:

- true compare mismatch
- temporary upstream error
- missing cached page
- fetch failure after retries
- staging redirected to production

Do not collapse all of these into generic `Comparison failed`.

Recommended row warning patterns:

- `Compare fetch failed after retries: ...`
- `Staging page missing from discovery cache`
- `Staging page redirected to production host`
- `Metadata mismatch`

### Validation

UI should communicate:

- what was a real SEO mismatch
- what was a fetch/infrastructure issue

## Data Model Considerations

### Where to store cache

Short-term:

- store inside `qa_discovery_jobs.state`

Pros:

- minimal schema change
- simplest rollout

Cons:

- large JSON blobs
- bigger write/read payloads per tick

Longer-term:

- move page snapshots to a dedicated table like `qa_discovery_pages`

Suggested shape:

```sql
run_id text
side text
path_key text
requested_url text
final_url text
title text
description text
description_source text
metadata_renderer text
html text
primary key (run_id, side, path_key)
```

Recommendation:

- start in JSON state for speed of implementation
- migrate to a table only if payload size becomes a real problem

## Cost and Performance Expectations

### Expected improvements

If compare stops re-fetching cached pages:

- fewer Apify sync actor runs
- fewer row-level 402 failures
- lower total run time
- lower Apify spend
- less Cloudways resource pressure

### What will still cost money

- discovery itself
- any fallback fetches still routed to Apify
- proxy usage

### What will still be slow sometimes

- pages behind bot protection
- pages requiring JS rendering
- redirect-heavy staging setups

## Rollout Strategy

### Step 1

Land Phase 1 and 2 behind a small feature flag if needed:

```env
DEFAULT_DISCOVERY_COMPARE_USE_CACHE=true
```

### Step 2

Test locally on a known site:

- one clean production/staging pair
- one redirecting staging-root case

### Step 3

Deploy to server with:

- `DEFAULT_APIFY_MAX_CONCURRENCY=1`
- `DEFAULT_MAX_DISCOVERY_PAGES_PER_SITE=150`
- local fallback still disabled

### Step 4

Compare before/after:

- total run time
- Apify usage
- number of row-level `Comparison failed`

## Validation Checklist

### Functional

- discovery still finds expected paths
- compare consumes cached snapshots when present
- missing cache falls back correctly
- production link checks still work
- redirect safeguard still works

### Operational

- no spike in PM2/Cloudways CPU due to compare
- fewer Apify actor runs per homepage crawl
- fewer transient compare failures

### UX

- UI warnings are specific
- rows do not all fail from one upstream incident
- run status stays aligned with actual progress

## Known Risks

1. Large discovery state JSON
   - mitigation: keep `maxPagesPerSite` conservative

2. Apify discovery dataset may not include HTML in the current actor output
   - mitigation: verify actor output shape first
   - fallback: enrich discovery snapshot via one static fetch per discovered page during discovery

3. Cached HTML may reflect redirect-resolved production pages in bad staging setups
   - mitigation: keep staging redirect guard strict

4. Compare logic complexity increases
   - mitigation: keep cache-first path narrow and explicit

## Open Questions

1. Does current Apify discovery dataset reliably include HTML when configured the current way?
2. Should discovery snapshot store full HTML or only parsed metadata plus production HTML for link checks?
3. Do we want a separate `OG description` / `Twitter description` column later, now that SEO description is strict?

## Recommended Next Execution Order

1. Verify discovery dataset shape from Apify for one fresh run
2. Add `pageCache` to discovery state
3. Cache parsed metadata and HTML during discovery
4. Make discovery compare read from cache first
5. Only then revisit compare strategy defaults

## Current Server Baseline

Current safe server posture:

- `DEFAULT_APIFY_COMPARE_FALLBACK_TO_LOCAL=false`
- `DEFAULT_APIFY_DISCOVERY_FALLBACK_TO_LOCAL=false`
- `DEFAULT_MAX_DISCOVERY_PAGES_PER_SITE=150`
- `DEFAULT_APIFY_MAX_CONCURRENCY=1`
- PM2 single process on port `3001`
- Nginx proxy to `127.0.0.1:3001`

This plan assumes that baseline remains in place during implementation.

