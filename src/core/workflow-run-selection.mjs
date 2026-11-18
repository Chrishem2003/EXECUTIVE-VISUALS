/** Normalize the server's newest-first workflow run history without trusting malformed entries. */
export function normalizeWorkflowRunHistory(runs) {
  if (!Array.isArray(runs)) return [];
  return runs
    .filter(run => run && typeof run === "object" && typeof run.id === "string" && run.id.trim().length > 0)
    .slice(0, 50)
    .map(run => ({
      id: run.id.trim(),
      status: typeof run.status === "string" ? run.status : "unknown",
      ...(typeof run.created_at === "string" ? { created_at: run.created_at } : {}),
      ...(typeof run.updated_at === "string" ? { updated_at: run.updated_at } : {})
    }));
}

/** Return the newest valid run identifier from the API's newest-first run list. */
export function getLatestWorkflowRunId(runs) {
  return normalizeWorkflowRunHistory(runs)[0]?.id || "";
}
