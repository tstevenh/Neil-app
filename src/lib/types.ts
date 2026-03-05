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

export type RunRecord = {
  id: string;
  userId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  progress: number;
  total: number;
  completed: number;
  results: CompareResult[];
  errors: string[];
};
