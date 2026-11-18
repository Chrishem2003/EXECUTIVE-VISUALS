/** Return the newest valid run identifier from the API's newest-first run list. */
export function getLatestWorkflowRunId(runs) {
  if (!Array.isArray(runs)) return "";
  const latest = runs.find(run => typeof run?.id === "string" && run.id.trim().length > 0);
  return latest?.id.trim() || "";
}
