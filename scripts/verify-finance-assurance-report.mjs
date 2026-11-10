import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function verifyFinanceAssuranceReport(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { valid: false, reason: "Report must be a JSON object." };
  }
  const { payload, integrity } = document;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      payload.schemaVersion !== 1 || payload.reportType !== "executive-financial-assurance") {
    return { valid: false, reason: "Unsupported or missing assurance report schema." };
  }
  if (!integrity || integrity.algorithm !== "SHA-256" ||
      !/^[a-f0-9]{64}$/i.test(String(integrity.sha256 || ""))) {
    return { valid: false, reason: "Missing or invalid SHA-256 integrity manifest." };
  }
  const actions = Array.isArray(payload.actions) ? payload.actions : null;
  if (!actions || !payload.completeness || !payload.summary) {
    return { valid: false, reason: "Report action list, completeness declaration, or summary is missing." };
  }
  const counts = {
    actionCount: actions.length,
    historyCount: actions.reduce((n, action) => n + (Array.isArray(action.history) ? action.history.length : 0), 0),
    auditEventCount: actions.reduce((n, action) => n + (Array.isArray(action.auditEvents) ? action.auditEvents.length : 0), 0),
    evidenceCount: actions.reduce((n, action) => n + (Array.isArray(action.evidence) ? action.evidence.length : 0), 0)
  };
  const countsMatch = Object.entries(counts).every(([key, value]) => value === integrity[key]);
  const included = payload.completeness.recordsIncluded;
  const total = payload.completeness.totalRecords;
  const completenessValid = Number.isSafeInteger(included) && Number.isSafeInteger(total) &&
    included === actions.length && total >= included &&
    payload.completeness.truncated === (total > included);
  const canonical = JSON.stringify(payload);
  const computedSha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
  const valid = computedSha256 === String(integrity.sha256).toLowerCase() && countsMatch && completenessValid;
  return {
    valid,
    reason: valid
      ? "SHA-256 digest, record counts, and completeness declaration match this report."
      : "Digest, record counts, or completeness declaration do not match; the report may be altered, incomplete, or malformed.",
    computedSha256,
    ...counts,
    complete: completenessValid && !payload.completeness.truncated
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const path = process.argv[2];
    if (!path) throw new Error("Usage: node scripts/verify-finance-assurance-report.mjs <report.json>");
    const document = JSON.parse(await readFile(path, "utf8"));
    const result = verifyFinanceAssuranceReport(document);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : "Assurance report verification failed.") + "\n");
    process.exitCode = 1;
  }
}
