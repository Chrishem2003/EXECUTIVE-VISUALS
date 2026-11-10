import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export function verifyAuditExport(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { valid: false, reason: "Export must be a JSON object." };
  }
  const { payload, integrity } = document;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.schemaVersion !== 1) {
    return { valid: false, reason: "Unsupported or missing export payload schema." };
  }
  if (!integrity || integrity.algorithm !== "SHA-256" || !/^[a-f0-9]{64}$/i.test(String(integrity.sha256 || ""))) {
    return { valid: false, reason: "Missing or invalid SHA-256 manifest." };
  }
  const canonical = JSON.stringify(payload);
  const computedSha256 = createHash("sha256").update(canonical, "utf8").digest("hex");
  const counts = {
    historyCount: Array.isArray(payload.history) ? payload.history.length : -1,
    auditEventCount: Array.isArray(payload.auditEvents) ? payload.auditEvents.length : -1,
    evidenceCount: Array.isArray(payload.evidence) ? payload.evidence.length : -1
  };
  const countsMatch = Object.entries(counts).every(([key, value]) => value >= 0 && value === integrity[key]);
  const valid = computedSha256 === String(integrity.sha256).toLowerCase() && countsMatch;
  return {
    valid,
    reason: valid ? "SHA-256 digest and manifest counts match this exported payload." : "Digest or manifest counts do not match; the export may be modified, incomplete, or malformed.",
    computedSha256,
    ...counts
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replaceAll("\\\\", "/")}`).href) {
  try {
    const path = process.argv[2];
    if (!path) throw new Error("Usage: node scripts/verify-remediation-audit-export.mjs <export.json>");
    const document = JSON.parse(await readFile(path, "utf8"));
    const result = verifyAuditExport(document);
    process.stdout.write(JSON.stringify(result, null, 2) + "\\n");
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : "Audit export verification failed.") + "\\n");
    process.exitCode = 1;
  }
}
