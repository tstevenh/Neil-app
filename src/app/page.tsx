"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import type { RunRecord } from "@/lib/types";
import { getSupabaseBrowser } from "@/lib/supabase-browser";

const RUN_LABELS_STORAGE_KEY = "qa-run-source-labels";

export default function Home() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);

  const [productionUrl, setProductionUrl] = useState("");
  const [stagingUrl, setStagingUrl] = useState("");
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [runDetailsById, setRunDetailsById] = useState<Record<string, RunRecord>>({});
  const [expandedResultRow, setExpandedResultRow] = useState<string | null>(null);
  const [runSourceLabels, setRunSourceLabels] = useState<Record<string, string>>({});
  const [cancelingRunIds, setCancelingRunIds] = useState<Record<string, boolean>>({});
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);

  async function getCurrentAccessToken() {
    const supabase = getSupabaseBrowser();
    const { data } = await supabase.auth.getSession();
    const currentToken = data.session?.access_token ?? null;
    setToken(currentToken);
    return currentToken;
  }

  async function apiFetch(path: string, init?: RequestInit) {
    const currentToken = await getCurrentAccessToken();
    if (!currentToken) {
      router.replace("/signin");
      throw new Error("You must be logged in.");
    }

    const buildHeaders = (accessToken: string) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${accessToken}`);
      return headers;
    };

    let response = await fetch(path, {
      ...init,
      headers: buildHeaders(currentToken),
    });

    if (response.status === 401) {
      const supabase = getSupabaseBrowser();
      const { data } = await supabase.auth.refreshSession();
      const refreshedToken = data.session?.access_token ?? null;
      setToken(refreshedToken);

      if (!refreshedToken) {
        router.replace("/signin");
        throw new Error("Session expired. Please sign in again.");
      }

      response = await fetch(path, {
        ...init,
        headers: buildHeaders(refreshedToken),
      });

      if (response.status === 401) {
        router.replace("/signin");
        throw new Error("Session expired. Please sign in again.");
      }
    }

    return response;
  }

  async function refreshRuns() {
    if (!token) {
      return;
    }

    try {
      const response = await apiFetch("/api/runs");
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error ?? "Failed to fetch runs");
        return;
      }

      setRuns(data.runs ?? []);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Failed to fetch runs";
      if (messageText.toLowerCase().includes("session expired")) {
        setToken(null);
        setRuns([]);
      }
      setMessage(messageText);
    }
  }

  async function loadRunDetails(runId: string) {
    try {
      const response = await apiFetch(`/api/runs/${runId}`);
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error ?? "Failed to fetch run details");
        return;
      }

      setRunDetailsById((current) => ({
        ...current,
        [runId]: data as RunRecord,
      }));
    } catch {
      setMessage("Network error while fetching run details");
    }
  }

  function toggleRunDetails(runId: string) {
    const willOpen = expandedRun !== runId;
    setExpandedRun(willOpen ? runId : null);
    setExpandedResultRow(null);
    if (willOpen) {
      void loadRunDetails(runId);
    }
  }

  function saveRunLabel(runId: string, label: string) {
    setRunSourceLabels((current) => {
      const next = {
        ...current,
        [runId]: label,
      };
      if (typeof window !== "undefined") {
        localStorage.setItem(RUN_LABELS_STORAGE_KEY, JSON.stringify(next));
      }
      return next;
    });
  }

  async function signOut() {
    const supabase = getSupabaseBrowser();
    await supabase.auth.signOut();
    setToken(null);
    setRuns([]);
    setExpandedRun(null);
    setRunDetailsById({});
    setMessage("Signed out.");
    router.push("/signin");
  }

  async function startSingleCompare() {
    setMessage("");
    try {
      const response = await apiFetch("/api/compare", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ productionUrl, stagingUrl }),
      });

      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error ?? "Failed to start compare run");
        return;
      }

      saveRunLabel(data.runId, "Single Compare");
      void refreshRuns();
      setMessage(`Run started: ${data.runId}`);
    } catch {
      setMessage("Network error: unable to reach API. Confirm `npm run dev` is running.");
    }
  }

  async function startBulkCompare() {
    if (!bulkFile) {
      setMessage("Select a CSV file first");
      return;
    }

    const formData = new FormData();
    formData.append("file", bulkFile);

    try {
      const response = await apiFetch("/api/compare/bulk", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error ?? "Failed to start bulk compare");
        return;
      }

      saveRunLabel(data.runId, bulkFile.name);
      void refreshRuns();
      setMessage(`Bulk run started: ${data.runId}`);
    } catch {
      setMessage("Network error: unable to reach bulk API. Refresh and try again.");
    }
  }

  async function downloadCsv(runId: string) {
    const sourceName = runSourceLabels[runId];
    const normalizedBase = (sourceName || "")
      .replace(/\.csv$/i, "")
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const exportFilename = `${normalizedBase || `qa-report-${runId}`} audited.csv`;

    try {
      const response = await apiFetch(`/api/runs/${runId}/export`);
      if (!response.ok) {
        const data = await response.json();
        setMessage(data.error ?? "Failed to export CSV");
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = exportFilename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setMessage("Failed to download CSV");
    }
  }

  async function cancelRunById(runId: string) {
    setCancelingRunIds((current) => ({ ...current, [runId]: true }));
    try {
      const response = await apiFetch(`/api/runs/${runId}/cancel`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error ?? "Failed to cancel run");
        return;
      }

      setMessage(`Run canceled: ${runId}`);
      await refreshRuns();
      if (expandedRun === runId) {
        await loadRunDetails(runId);
      }
    } catch {
      setMessage("Network error while canceling run");
    } finally {
      setCancelingRunIds((current) => ({ ...current, [runId]: false }));
    }
  }

  async function retryFailedRowsForRun(runId: string) {
    const source = runSourceLabels[runId] ?? "Run";
    setRetryingRunId(runId);
    try {
      const response = await apiFetch(`/api/runs/${runId}/retry-failed`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) {
        setMessage(data.error ?? "Failed to retry failed rows");
        return;
      }

      saveRunLabel(data.runId, `Retry Failed - ${source}`);
      await refreshRuns();
      setMessage(`Retry run started: ${data.runId}`);
    } catch {
      setMessage("Network error while retrying failed rows");
    } finally {
      setRetryingRunId(null);
    }
  }

  useEffect(() => {
    const initAuth = async () => {
      try {
        if (typeof window !== "undefined") {
          const raw = localStorage.getItem(RUN_LABELS_STORAGE_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as Record<string, string>;
            setRunSourceLabels(parsed);
          }
        }

        const supabase = getSupabaseBrowser();
        const { data } = await supabase.auth.getSession();
        setToken(data.session?.access_token ?? null);

        const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
          setToken(session?.access_token ?? null);
        });

        return () => listener.subscription.unsubscribe();
      } finally {
        setIsAuthLoading(false);
      }
    };

    let cleanup: (() => void) | undefined;
    void initAuth().then((fn) => {
      cleanup = fn;
    });

    return () => {
      cleanup?.();
    };
  }, []);

  useEffect(() => {
    if (!token) {
      return;
    }

    void refreshRuns();

    const interval = setInterval(() => {
      void refreshRuns();
    }, 2500);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (!isAuthLoading && !token) {
      router.replace("/signin");
    }
  }, [isAuthLoading, token, router]);

  const latestRuns = useMemo(() => runs.slice(0, 10), [runs]);
  const activeRuns = useMemo(
    () => runs.filter((run) => run.status === "queued" || run.status === "running"),
    [runs],
  );
  const completedRunsCount = useMemo(
    () => runs.filter((run) => run.status === "completed").length,
    [runs],
  );
  const canceledRunsCount = useMemo(
    () => runs.filter((run) => run.status === "canceled").length,
    [runs],
  );
  const selectedRun = useMemo(
    () => (expandedRun ? runDetailsById[expandedRun] ?? null : null),
    [expandedRun, runDetailsById],
  );
  const selectedRunSummary = useMemo(() => {
    if (!selectedRun) {
      return null;
    }
    const blockedCount = selectedRun.results.filter((result) =>
      result.warnings.some((warning) => warning.toLowerCase().includes("blocked:")),
    ).length;
    const passCount = selectedRun.results.filter((result) => result.overallStatus === "PASS").length;
    const failCount = selectedRun.results.length - passCount;
    return { passCount, failCount, blockedCount };
  }, [selectedRun]);

  const displayValue = (value: string) => value.trim() || "Missing";
  const isMissingValue = (value: string) => !value.trim();
  const isCancelable = (run: RunRecord) => run.status === "queued" || run.status === "running";
  const runSourceText = (run: RunRecord) => {
    if (runSourceLabels[run.id]) {
      return runSourceLabels[run.id];
    }
    return run.total > 1 ? "Bulk CSV" : "Single Compare";
  };
  const primaryButtonClass =
    "rounded-full bg-[#234167] px-5 py-2.5 text-sm font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60";
  const secondaryButtonClass =
    "rounded-full border border-[#d4e5ea] bg-white px-5 py-2.5 text-sm font-medium text-[#234167] transition hover:bg-[#f3fbfd] disabled:cursor-not-allowed disabled:opacity-60";
  const smallButtonClass =
    "rounded-full border border-[#d4e5ea] bg-white px-3 py-1.5 text-xs font-medium text-[#234167] transition hover:bg-[#f3fbfd] disabled:cursor-not-allowed disabled:opacity-60";
  const cardClass = "rounded-[24px] border border-[#dce8ec] bg-white shadow-[0_14px_35px_-24px_rgba(0,0,0,0.45)]";

  if (isAuthLoading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f3fbfd] p-8">
        <div className={`${cardClass} px-8 py-6 text-[#234167]`}>Loading...</div>
      </main>
    );
  }

  if (!token) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f3fbfd] p-8">
        <div className={`${cardClass} px-8 py-6 text-[#234167]`}>Redirecting to sign in...</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen overflow-x-hidden bg-[#f3fbfd] p-4 text-slate-900 md:p-7">
      <div className="mx-auto min-w-0 max-w-7xl space-y-6">
        <header className={`flex flex-col gap-4 p-6 md:flex-row md:items-center md:justify-between ${cardClass}`}>
          <div className="space-y-2">
            <Image src="/digirx-logo.svg" alt="DigiRX" width={144} height={50} />
            <h1 className="text-3xl font-medium text-[#101828] md:text-4xl">QA Workbench</h1>
            <p className="text-sm text-[#5a6a74]">
              Internal workflow for comparing production and staging URLs before handoff.
            </p>
          </div>
          <button type="button" className={secondaryButtonClass} onClick={signOut}>
            Sign Out
          </button>
        </header>

        <section className={`grid gap-3 p-4 md:grid-cols-5 ${cardClass}`}>
          <div className="rounded-2xl border border-[#d8ebef] bg-[#e3faff] p-4 md:col-span-2">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#234167]">Step 1</p>
            <p className="mt-1 text-sm font-medium text-[#101828]">Add one URL pair or upload CSV.</p>
          </div>
          <div className="rounded-2xl border border-[#d8ebef] bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#234167]">Step 2</p>
            <p className="mt-1 text-sm font-medium text-[#101828]">Review active run progress.</p>
          </div>
          <div className="rounded-2xl border border-[#d8ebef] bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#234167]">Step 3</p>
            <p className="mt-1 text-sm font-medium text-[#101828]">Inspect details and export CSV.</p>
          </div>
          <div className="rounded-2xl border border-[#d8ebef] bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#234167]">Runs</p>
            <p className="mt-1 text-sm text-[#5a6a74]">
              Active <strong>{activeRuns.length}</strong>, Completed <strong>{completedRunsCount}</strong>,
              Canceled <strong>{canceledRunsCount}</strong>
            </p>
          </div>
        </section>

        <section className={`grid min-w-0 gap-4 p-6 md:grid-cols-2 ${cardClass}`}>
          <div className="min-w-0 space-y-3 rounded-2xl border border-[#deedf1] bg-white p-4">
            <h2 className="text-xl font-medium text-[#101828]">Single Compare</h2>
            <input
              className="w-full rounded-xl border border-[#d2e6ea] bg-white px-4 py-2.5 text-sm outline-none transition focus:border-[#6cc8dd]"
              placeholder="Production URL"
              value={productionUrl}
              onChange={(event) => setProductionUrl(event.target.value)}
            />
            <input
              className="w-full rounded-xl border border-[#d2e6ea] bg-white px-4 py-2.5 text-sm outline-none transition focus:border-[#6cc8dd]"
              placeholder="Staging URL"
              value={stagingUrl}
              onChange={(event) => setStagingUrl(event.target.value)}
            />
            <button type="button" className={primaryButtonClass} onClick={startSingleCompare}>
              Run Check
            </button>
          </div>

          <div className="min-w-0 space-y-3 rounded-2xl border border-[#deedf1] bg-white p-4">
            <h2 className="text-xl font-medium text-[#101828]">Bulk Upload (CSV)</h2>
            <p className="text-xs text-[#5a6a74]">
              Supports: `production_url/staging_url` or `Production URL/Staging URL`. Max 150 rows.
            </p>
            <input
              type="file"
              accept=".csv"
              className="block w-full max-w-full text-sm text-[#234167] file:mr-3 file:rounded-full file:border file:border-[#d4e5ea] file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[#234167] file:transition file:hover:bg-[#f3fbfd]"
              onChange={(event) => setBulkFile(event.target.files?.[0] ?? null)}
            />
            <button type="button" className={primaryButtonClass} onClick={startBulkCompare}>
              Run Bulk Check
            </button>
          </div>
        </section>

        {message ? (
          <section className={`${cardClass} rounded-2xl border-l-4 border-l-[#6cc8dd] p-4 text-sm text-[#234167]`}>
            {message}
          </section>
        ) : null}

        {activeRuns.length > 0 ? (
          <section className={`min-w-0 p-5 ${cardClass}`}>
            <h3 className="text-lg font-medium text-[#101828]">Active Runs</h3>
            <div className="mt-3 w-full overflow-x-auto rounded-2xl border border-[#deedf1]">
              <table className="min-w-full text-sm">
                <thead className="bg-[#e3faff] text-left text-[#234167]">
                  <tr>
                    <th className="p-3">Run ID</th>
                    <th className="p-3">Source</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Progress</th>
                    <th className="p-3">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {activeRuns.map((run) => (
                    <tr key={`active-${run.id}`} className="border-t border-[#ecf2f4]">
                      <td className="p-3 font-mono text-xs">{run.id}</td>
                      <td className="p-3">{runSourceText(run)}</td>
                      <td className="p-3 capitalize">{run.status}</td>
                      <td className="p-3">{run.progress}%</td>
                      <td className="p-3">
                        <button
                          type="button"
                          className={smallButtonClass}
                          disabled={!isCancelable(run) || Boolean(cancelingRunIds[run.id])}
                          onClick={() => void cancelRunById(run.id)}
                        >
                          {cancelingRunIds[run.id] ? "Canceling..." : "Cancel"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section className="min-w-0 space-y-4">
          <section className={`min-w-0 overflow-hidden ${cardClass}`}>
            <div className="border-b border-[#deedf1] p-4">
              <h2 className="text-lg font-medium text-[#101828]">Recent Runs</h2>
            </div>

            <div className="w-full overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-[#e3faff] text-left text-[#234167]">
                  <tr>
                    <th className="p-3">Run ID</th>
                    <th className="p-3">Source</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Progress</th>
                    <th className="p-3">Rows</th>
                    <th className="p-3">Export</th>
                  </tr>
                </thead>
                <tbody>
                  {latestRuns.map((run) => (
                    <tr key={run.id} className="border-t border-[#ecf2f4] align-top">
                      <td className="p-3">
                        <button
                          type="button"
                          className="font-mono text-xs text-[#234167] underline decoration-[#6cc8dd] decoration-2"
                          onClick={() => toggleRunDetails(run.id)}
                        >
                          {run.id}
                        </button>
                      </td>
                      <td className="p-3 break-words">{runSourceText(run)}</td>
                      <td className="p-3 capitalize">{run.status}</td>
                      <td className="p-3">{run.progress}%</td>
                      <td className="p-3">{run.total}</td>
                      <td className="p-3">
                        <button
                          type="button"
                          className={smallButtonClass}
                          onClick={() => void downloadCsv(run.id)}
                        >
                          CSV
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={`min-w-0 space-y-3 p-4 ${cardClass}`}>
            <div className="flex flex-col gap-2 border-b border-[#deedf1] pb-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-medium text-[#101828]">Run Details</h3>
                {selectedRun && (selectedRunSummary?.failCount ?? 0) > 0 ? (
                  <button
                    type="button"
                    className={smallButtonClass}
                    disabled={retryingRunId === selectedRun.id}
                    onClick={() => void retryFailedRowsForRun(selectedRun.id)}
                  >
                    {retryingRunId === selectedRun.id ? "Retrying..." : "Re-run Failed Rows"}
                  </button>
                ) : null}
              </div>
              {selectedRun ? (
                <>
                  <p className="text-xs text-[#5a6a74]">
                    Source: <span className="font-medium text-[#234167]">{runSourceText(selectedRun)}</span> | Run ID:{" "}
                    <span className="font-mono">{selectedRun.id}</span>
                  </p>
                  <p className="text-xs text-[#5a6a74]">
                    Pass {selectedRunSummary?.passCount ?? 0} | Fail {selectedRunSummary?.failCount ?? 0} | Blocked{" "}
                    <span className={(selectedRunSummary?.blockedCount ?? 0) > 0 ? "font-semibold text-rose-600" : ""}>
                      {selectedRunSummary?.blockedCount ?? 0}
                    </span>
                  </p>
                </>
              ) : null}
            </div>
            {!expandedRun ? (
              <p className="text-sm text-[#5a6a74]">
                Select a run ID from Recent Runs to inspect row-level QA results.
              </p>
            ) : null}
            {expandedRun ? (
              selectedRun ? (
                <div className="w-full overflow-x-auto rounded-[20px] border border-[#deedf1]">
                  <table className="min-w-full text-xs">
                    <thead className="bg-[#e3faff] text-left text-[#234167]">
                      <tr>
                        <th className="p-2">Production URL</th>
                        <th className="p-2">Staging URL</th>
                        <th className="p-2">Title</th>
                        <th className="p-2">Description</th>
                        <th className="p-2">Slug</th>
                        <th className="p-2">404</th>
                        <th className="p-2">#</th>
                        <th className="p-2">Overall</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedRun.results.map((result, index) => (
                        <Fragment key={`preview-${result.productionUrl}-${index}`}>
                          <tr
                            className="cursor-pointer border-t border-[#ecf2f4] hover:bg-[#f7fcfd]"
                            onClick={() =>
                              setExpandedResultRow((current) =>
                                current === `${selectedRun.id}-${index}`
                                  ? null
                                  : `${selectedRun.id}-${index}`,
                              )
                            }
                          >
                            <td
                              className={`p-2 break-all ${isMissingValue(result.productionUrl) ? "text-rose-600 font-semibold" : ""}`}
                            >
                              {displayValue(result.productionUrl)}
                            </td>
                            <td
                              className={`p-2 break-all ${isMissingValue(result.stagingUrl) ? "text-rose-600 font-semibold" : ""}`}
                            >
                              {displayValue(result.stagingUrl)}
                            </td>
                            <td className={`p-2 ${result.titleMatch ? "" : "text-rose-600 font-semibold"}`}>
                              {result.titleMatch ? "OK" : "FAIL"}
                            </td>
                            <td
                              className={`p-2 ${result.descriptionMatch ? "" : "text-rose-600 font-semibold"}`}
                            >
                              {result.descriptionMatch ? "OK" : "FAIL"}
                            </td>
                            <td className={`p-2 ${result.slugMatch ? "" : "text-rose-600 font-semibold"}`}>
                              {result.slugMatch ? "OK" : "FAIL"}
                            </td>
                            <td
                              className={`p-2 ${result.brokenLinksCount > 0 ? "text-rose-600 font-semibold" : ""}`}
                            >
                              {result.brokenLinksCount}
                            </td>
                            <td
                              className={`p-2 ${result.hashLinksCount > 0 ? "text-rose-600 font-semibold" : ""}`}
                            >
                              {result.hashLinksCount}
                            </td>
                            <td
                              className={`p-2 ${result.overallStatus === "FAIL" ? "text-rose-600 font-semibold" : "text-emerald-700 font-semibold"}`}
                            >
                              {result.overallStatus}
                            </td>
                          </tr>
                          {expandedResultRow === `${selectedRun.id}-${index}` ? (
                            <tr className="border-t border-[#ecf2f4] bg-[#f7fcfd]">
                              <td className="p-3 text-xs" colSpan={8}>
                                <div className="space-y-2">
                                  <p className="font-semibold">Notes</p>
                                  {result.warnings.length > 0 ? (
                                    <ul className="list-disc pl-5">
                                      {result.warnings.map((warning) => (
                                        <li key={warning}>{warning}</li>
                                      ))}
                                    </ul>
                                  ) : (
                                    <p className="text-slate-600">No notes.</p>
                                  )}
                                  {result.brokenLinks.length > 0 ? (
                                    <div>
                                      <p className="font-semibold text-rose-600">404 URLs</p>
                                      <ul className="list-disc pl-5">
                                        {result.brokenLinks.map((link) => (
                                          <li key={link.url} className="break-all">
                                            {link.url} ({link.status})
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  ) : null}
                                  {result.hashLinks.length > 0 ? (
                                    <div>
                                      <p className="font-semibold text-rose-600"># URLs</p>
                                      <ul className="list-disc pl-5">
                                        {result.hashLinks.map((link) => (
                                          <li key={link} className="break-all">
                                            {link}
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  ) : null}
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-slate-600">Loading run details...</p>
              )
            ) : null}
          </section>
        </section>
      </div>
    </main>
  );
}
