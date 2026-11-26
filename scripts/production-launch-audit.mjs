import { evaluateProductionLaunchGate } from "../server/production-launch-gate.mjs";

const baseUrl = String(process.env.EXECUTIVE_VISUALS_BASE_URL || "").trim().replace(/\/+$/, "");
if (!baseUrl) {
  console.error("EXECUTIVE_VISUALS_BASE_URL is required.");
  process.exit(2);
}
let url;
try {
  url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("HTTPS is required for non-local launch audits.");
  }
} catch {
  console.error("EXECUTIVE_VISUALS_BASE_URL must be a valid HTTPS URL (or localhost).");
  process.exit(2);
}

let health;
try {
  const response = await fetch(new URL("/api/health", url), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15000),
    redirect: "error"
  });
  if (!response.ok) throw new Error("Health endpoint returned HTTP " + response.status);
  health = await response.json();
} catch (error) {
  console.error("Launch audit could not obtain a trusted health response:", String(error?.message || error));
  process.exit(2);
}

const evidence = {
  privateBucketVerifiedAt: process.env.PRIVATE_BUCKET_VERIFIED_AT,
  workerHeartbeatVerifiedAt: process.env.WORKER_HEARTBEAT_VERIFIED_AT,
  backupRestoreVerifiedAt: process.env.BACKUP_RESTORE_VERIFIED_AT,
  monitoringAlertVerifiedAt: process.env.MONITORING_ALERT_VERIFIED_AT
};
const report = evaluateProductionLaunchGate({ health, evidence });
console.log(JSON.stringify(report, null, 2));
if (!report.launchAllowed) process.exit(1);
