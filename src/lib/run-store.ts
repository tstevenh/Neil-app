import { randomUUID } from "node:crypto";
import type { CompareResult, RunRecord, RunStatus, UrlPair } from "@/lib/types";
import { comparePair } from "@/lib/compare";
import { MAX_RUNNING_RUNS_PER_USER, ROW_PACING_DELAY_MS } from "@/lib/runtime-config";
import { getSupabaseAdmin } from "@/lib/supabase-admin";

const PROCESS_ROWS_PER_TICK = 1;

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

type RunInputRow = {
  run_id: string;
  row_index: number;
  production_url: string;
  staging_url: string;
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
  const { error } = await supabaseAdmin.from("qa_runs").update(patch).eq("id", id);
  if (error) {
    throw new Error(`Failed to update run ${id}: ${error.message}`);
  }
}

async function getRunRowById(id: string): Promise<RunRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAdmin = getSupabaseAdmin() as any;
  const { data, error } = await supabaseAdmin.from("qa_runs").select("*").eq("id", id).single();
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
    const details = `${error.code ?? ""} ${error.message ?? ""}`;
    if (details.includes("duplicate") || details.includes("23505")) {
      return;
    }
    throw new Error(`Failed to append run result: ${error.message}`);
  }
}

async function getRunningRunsByUser(userId: string, limit: number): Promise<RunRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAdmin = getSupabaseAdmin() as any;
  const { data, error } = await supabaseAdmin
    .from("qa_runs")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "running")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to read running runs: ${error.message}`);
  }

  return (data ?? []) as RunRow[];
}

async function getRunningRunsCountByUser(userId: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAdmin = getSupabaseAdmin() as any;
  const { count, error } = await supabaseAdmin
    .from("qa_runs")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "running");

  if (error) {
    throw new Error(`Failed to check running runs: ${error.message}`);
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
    throw new Error(`Failed to claim run ${id}: ${error.message}`);
  }

  return Array.isArray(data) && data.length > 0;
}

async function readRunInputRow(runId: string, rowIndex: number): Promise<RunInputRow | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabaseAdmin = getSupabaseAdmin() as any;
  const { data, error } = await supabaseAdmin
    .from("qa_run_inputs")
    .select("run_id,row_index,production_url,staging_url")
    .eq("run_id", runId)
    .eq("row_index", rowIndex)
    .single();

  if (error || !data) {
    return null;
  }

  return data as RunInputRow;
}

function shouldWaitForRowPacing(run: RunRow) {
  if (ROW_PACING_DELAY_MS <= 0 || run.completed === 0) {
    return false;
  }

  const updatedAt = Date.parse(run.updated_at);
  if (Number.isNaN(updatedAt)) {
    return false;
  }

  return Date.now() - updatedAt < ROW_PACING_DELAY_MS;
}

async function processRunTick(run: RunRow) {
  let latest = await getRunRowById(run.id);
  if (!latest) {
    return;
  }

  if (latest.status === "canceled" || latest.status === "completed" || latest.status === "failed") {
    return;
  }

  let remaining = PROCESS_ROWS_PER_TICK;
  while (remaining > 0) {
    latest = await getRunRowById(run.id);
    if (!latest) {
      return;
    }

    if (latest.status === "canceled" || latest.status === "failed") {
      return;
    }

    if (latest.completed >= latest.total) {
      await updateRun(latest.id, {
        status: latest.errors.length > 0 ? "failed" : "completed",
      });
      return;
    }

    if (shouldWaitForRowPacing(latest)) {
      return;
    }

    const row = await readRunInputRow(latest.id, latest.completed);
    if (!row) {
      const nextErrors = [...latest.errors, `Missing input row at index ${latest.completed}`];
      await updateRun(latest.id, { status: "failed", errors: nextErrors });
      return;
    }

    const pair: UrlPair = {
      productionUrl: row.production_url,
      stagingUrl: row.staging_url,
    };

    let result: CompareResult;
    const nextErrors = [...latest.errors];
    try {
      result = await comparePair(pair);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown compare error";
      nextErrors.push(`${pair.productionUrl} -> ${pair.stagingUrl}: ${message}`);
      result = buildFailedCompareResult(pair, message);
    }

    await appendResult(latest.id, latest.completed, result);

    const completed = latest.completed + 1;
    const progress = Math.round((completed / latest.total) * 100);
    await updateRun(latest.id, {
      completed,
      progress,
      errors: nextErrors,
      status: completed >= latest.total ? (nextErrors.length > 0 ? "failed" : "completed") : "running",
    });

    remaining -= 1;
  }
}

async function tryStartQueuedRuns(userId: string) {
  const runningCount = await getRunningRunsCountByUser(userId);
  const availableSlots = Math.max(0, MAX_RUNNING_RUNS_PER_USER - runningCount);
  if (availableSlots === 0) {
    return;
  }

  const queuedRunIds = await getQueuedRunIdsByUser(userId, availableSlots);
  for (const runId of queuedRunIds) {
    await claimRunForProcessing(runId);
  }
}

async function dispatchUserRuns(userId: string) {
  await tryStartQueuedRuns(userId);
  const runningRuns = await getRunningRunsByUser(userId, MAX_RUNNING_RUNS_PER_USER);
  await Promise.all(runningRuns.map((run) => processRunTick(run)));
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

  const inputRows = pairs.map((pair, rowIndex) => ({
    run_id: id,
    row_index: rowIndex,
    production_url: pair.productionUrl,
    staging_url: pair.stagingUrl,
  }));

  const { error: inputError } = await supabaseAdmin.from("qa_run_inputs").insert(inputRows);
  if (inputError) {
    throw new Error(`Failed to store run inputs: ${inputError.message}`);
  }

  void dispatchUserRuns(userId);
  return mapRun(data as RunRow, []);
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

  await dispatchUserRuns(userId);
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

  const typedRun = run as RunRow;
  await dispatchUserRuns(typedRun.user_id);

  const refreshedRun = await getRunRowById(typedRun.id);
  if (!refreshedRun) {
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

  return mapRun(refreshedRun, ((rows ?? []) as RunResultRow[]).map((row) => row.result));
}

export async function getRunsByUser(userId: string) {
  await dispatchUserRuns(userId);

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
