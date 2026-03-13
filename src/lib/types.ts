export type OverallStatus = "PASS" | "FAIL";

export type BadLink = {
  url: string;
  status: number;
};

export type CompareResult = {
  productionUrl: string;
  stagingUrl: string;
  finalProductionUrl: string;
  finalStagingUrl: string;
  prodTitle: string;
  stagingTitle: string;
  titleMatch: boolean;
  prodDescription: string;
  stagingDescription: string;
  descriptionMatch: boolean;
  prodSlug: string;
  stagingSlug: string;
  slugMatch: boolean;
  totalLinks: number;
  brokenLinksCount: number;
  hashLinksCount: number;
  anchorLinksCount: number;
  brokenLinks: BadLink[];
  hashLinks: string[];
  warnings: string[];
  overallStatus: OverallStatus;
  error?: string;
};

export type RunStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export type UrlPair = {
  productionUrl: string;
  stagingUrl: string;
};

export type DiscoveryPageSnapshot = {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  description: string;
  descriptionSource: "meta:description" | "embedded:site_info.description" | "none";
  metadataRenderer: "apify" | "static";
  html: string;
  usedRenderer: "apify" | "static";
};

export type RunRecord = {
  id: string;
  userId: string;
  runMode?: "standard" | "discover_stream";
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  progress: number;
  total: number;
  completed: number;
  results: CompareResult[];
  errors: string[];
  discoveryDiagnostics?: {
    warnings: string[];
    pendingComparisons: number;
    totalPaths: number;
    useApifyProxy: boolean;
    production: {
      provider: string;
      discoveredPaths: number;
      allowedHosts: string[];
      queueSize: number;
      visitedCount: number;
      apifyRunId: string;
      apifyDatasetId: string;
    };
    staging: {
      provider: string;
      discoveredPaths: number;
      allowedHosts: string[];
      queueSize: number;
      visitedCount: number;
      apifyRunId: string;
      apifyDatasetId: string;
    };
  };
};
