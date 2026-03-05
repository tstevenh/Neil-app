import { randomUUID } from "node:crypto";
import type { CompareResult, RunRecord, RunStatus, UrlPair } from "@/lib/types";
import { comparePair } from "@/lib/compare";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const MAX_RUNNING_RUNS_PER_USER = 3;
const pendingRunPairs = new Map<string, UrlPair[]>();

type RunRow = {
  id: string;
  user_id: string;
  status: RunStatus;
  progress: number;
  total: number;
  completed: number;
  errors: string[];
  created_at: string;
  updated_at: string;
};

type RunResultRow = {
  row_index: number;
  result: CompareResult;
};

function mapRun(row: RunRow, results: CompareResult[]): RunRecord {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    progress: row.progress,
    total: row.total,
    completed: row.completed,
    results,
    errors: Array.isArray(row.errors) ? row.errors : [],
  };
}

function buildFailedCompareResult(pair: UrlPair, message: string): CompareResult {
  return {
    productionUrl: pair.productionUrl,
    stagingUrl: pair.stagingUrl,
    finalProductionUrl: pair.productionUrl,
    finalStagingUrl: pair.stagingUrl,
    prodTitle: "",
    stagingTitle: "",
    titleMatch: false,
    prodDescription: "",
    stagingDescription: "",
    descriptionMatch: false,
    prodSlug: "",
    stagingSlug: "",
    slugMatch: false,
    totalLinks: 0,
    brokenLinksCount: 0,
    hashLinksCount: 0,
    anchorLinksCount: 0,
    brokenLinks: [],
    hashLinks: [],
    warnings: ["Comparison failed"],
    overallStatus: "FAIL",
    error: message,
  };
}

async function updateRun(id: string, patch: Partial<RunRow>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAdmin = getSupabaseAdmin() as any;
  const { error } = await supabaseAdmin
    .from("qa_runs")
    .update(patch)
    .eq("id", id);

  if (error) {
    throw new Error(`Failed to update run ${id}: ${error.message}`);
  }
}

async function getRunRowById(id: string): Promise<RunRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAdmin = getSupabaseAdmin() as any;
  const { data, error } = await supabaseAdmin
    .from("qa_runs")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    return null;
  }

  return data as RunRow;
}

async function appendResult(id: string, index: number, result: CompareResult) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAdmin = getSupabaseAdmin() as any;
  const { error } = await supabaseAdmin.from("qa_run_results").insert({
    run_id: id,
    row_index: index,
    result,
  });

  if (error) {
    throw new Error(`Failed to append run result: ${error.message}`);
  }
}

async function getActiveRunsCountByUser(userId: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAdmin = getSupabaseAdmin() as any;
  const { count, error } = await supabaseAdmin
    .from("qa_runs")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "running");

  if (error) {
    throw new Error(`Failed to check active runs: ${error.message}`);
  }

  return Number(count ?? 0);
}

async function getQueuedRunIdsByUser(userId: string, limit: number): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAdmin = getSupabaseAdmin() as any;
  const { data, error } = await supabaseAdmin
    .from("qa_runs")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to read queued runs: ${error.message}`);
  }

  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
}

async function claimRunForProcessing(id: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAdmin = getSupabaseAdmin() as any;
  const { data, error } = await supabaseAdmin
    .from("qa_runs")
    .update({ status: "running" })
    .eq("id", id)
    .eq("status", "queued")
    .select("id")
    .limit(1);

  if (error) {
    throw new Error(`Failed to claim queued run ${id}: ${error.message}`);
  }

  return Array.isArray(data) && data.length > 0;
}

async function tryStartQueuedRuns(userId: string) {
  const runningCount = await getActiveRunsCountByUser(userId);
  const availableSlots = Math.max(0, MAX_RUNNING_RUNS_PER_USER - runningCount);
  if (availableSlots === 0) {
    return;
  }

  const queuedRunIds = await getQueuedRunIdsByUser(userId, availableSlots);
  for (const runId of queuedRunIds) {
    const pairs = pendingRunPairs.get(runId);
    if (!pairs) {
      continue;
    }
    void processRun(runId, pairs, userId);
  }
}

export async function createRun(userId: string, pairs: UrlPair[]): Promise<RunRecord> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAdmin = getSupabaseAdmin() as any;
  const id = randomUUID();

  const { data, error } = await supabaseAdmin
    .from("qa_runs")
    .insert({
      id,
      user_id: userId,
      status: "queued",
      progress: 0,
      total: pairs.length,
      completed: 0,
      errors: [],
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create run: ${error?.message ?? "Unknown error"}`);
  }

  const runRow = data as RunRow;
  pendingRunPairs.set(runRow.id, pairs);
  void tryStartQueuedRuns(userId);
  return mapRun(runRow, []);
}

async function processRun(id: string, pairs: UrlPair[], userId: string) {
  const errors: string[] = [];

  try {
    const claimed = await claimRunForProcessing(id);
    if (!claimed) {
      return;
    }

    const initialRun = await getRunRowById(id);
    if (!initialRun || initialRun.status === "canceled") {
      return;
    }

    for (let index = 0; index < pairs.length; index += 1) {
      const latestRun = await getRunRowById(id);
      if (!latestRun || latestRun.status === "canceled") {
        return;
      }

      const pair = pairs[index];
      let result: CompareResult;

      try {
        result = await comparePair(pair);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown compare error";
        errors.push(`${pair.productionUrl} -> ${pair.stagingUrl}: ${message}`);
        result = buildFailedCompareResult(pair, message);
      }

      await appendResult(id, index, result);

      const completed = index + 1;
      const progress = Math.round((completed / pairs.length) * 100);
      await updateRun(id, {
        completed,
        progress,
        errors,
      });
    }

    const completedRun = await getRunRowById(id);
    if (!completedRun || completedRun.status === "canceled") {
      return;
    }

    await updateRun(id, {
      status: errors.length > 0 ? "failed" : "completed",
      errors,
    });
  } catch (error) {
    const currentRun = await getRunRowById(id);
    if (!currentRun || currentRun.status === "canceled") {
      return;
    }

    const message = error instanceof Error ? error.message : "Unexpected run failure";
    const nextErrors = [...errors, message];

    try {
      await updateRun(id, {
        status: "failed",
        errors: nextErrors,
      });
    } catch {
      // no-op: avoid throwing in detached background task
    }
  } finally {
    pendingRunPairs.delete(id);
    await tryStartQueuedRuns(userId);
  }
}

export async function cancelRun(userId: string, id: string) {
  const run = await getRunRowById(id);
  if (!run || run.user_id !== userId) {
    return null;
  }

  if (run.status === "completed" || run.status === "failed" || run.status === "canceled") {
    return mapRun(run, []);
  }

  const nextErrors = Array.isArray(run.errors) ? [...run.errors] : [];
  nextErrors.push(`Canceled by user at ${new Date().toISOString()}`);

  await updateRun(id, {
    status: "canceled",
    errors: nextErrors,
  });

  const updated = await getRunRowById(id);
  if (!updated) {
    return null;
  }

  return mapRun(updated, []);
}

export async function getRunById(id: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAdmin = getSupabaseAdmin() as any;
  const { data: run, error: runError } = await supabaseAdmin
    .from("qa_runs")
    .select("*")
    .eq("id", id)
    .single();

  if (runError || !run) {
    return null;
  }

  const { data: rows, error: resultsError } = await supabaseAdmin
    .from("qa_run_results")
    .select("row_index,result")
    .eq("run_id", id)
    .order("row_index", { ascending: true });

  if (resultsError) {
    throw new Error(`Failed to fetch run results: ${resultsError.message}`);
  }

  return mapRun(run as RunRow, ((rows ?? []) as RunResultRow[]).map((row) => row.result));
}

export async function getRunsByUser(userId: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAdmin = getSupabaseAdmin() as any;
  const { data: runs, error } = await supabaseAdmin
    .from("qa_runs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    throw new Error(`Failed to fetch runs: ${error.message}`);
  }

  return ((runs ?? []) as RunRow[]).map((run) => mapRun(run, []));
}
