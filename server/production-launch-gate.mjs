const MAX_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REQUIRED_EVIDENCE = Object.freeze([
  ["privateBucketVerifiedAt", "PRIVATE_BUCKET_VERIFICATION_MISSING"],
  ["workerHeartbeatVerifiedAt", "WORKER_HEARTBEAT_VERIFICATION_MISSING"],
  ["backupRestoreVerifiedAt", "BACKUP_RESTORE_VERIFICATION_MISSING"],
  ["monitoringAlertVerifiedAt", "MONITORING_ALERT_VERIFICATION_MISSING"]
]);

function recentTimestamp(value, now, maxAgeMs = MAX_EVIDENCE_AGE_MS) {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at <= now && now - at <= maxAgeMs;
}

/**
 * Conservative customer-launch gate. HTTP reachability is deliberately not
 * treated as proof of durable storage, worker liveness, backup recovery or alerting.
 */
export function evaluateProductionLaunchGate({ health, evidence = {}, now = Date.now() } = {}) {
  const blockers = [];
  const checks = {};
  const check = (name, passed, code) => {
    checks[name] = passed === true;
    if (!passed) blockers.push(code);
  };

  check("health", health?.status === "ok", "HEALTH_NOT_OK");
  check("supabaseAuth", health?.authMode === "supabase" && health?.authSession?.configurationReady === true,
    "SUPABASE_AUTH_NOT_READY");

  const cloud = health?.cloudMedia || {};
  check("privateCloudStorage", cloud.enabled === true && cloud.ready === true && cloud.storage === "private",
    "PRIVATE_CLOUD_STORAGE_NOT_VERIFIED");

  check("durableDatabase", typeof health?.database === "string" &&
    !["sqlite", "local", "memory"].includes(health.database.toLowerCase()) &&
    health?.creativeArtifacts?.ready === true &&
    health?.creativeArtifacts?.durableAcrossDeploys === true,
    "DURABLE_DATABASE_NOT_VERIFIED");

  const worker = health?.cloudVideoWorker || {};
  check("workerConfiguration", worker.enabled === true &&
    worker.remoteExecutionGates === true &&
    worker.supabaseCredentialsConfigured === true &&
    worker.outputHostAllowlistConfigured === true &&
    worker.runtimeMode === "separate-process",
    "DURABLE_WORKER_CONFIGURATION_NOT_READY");

  check("privateDownloadAccounting", health?.privateAssetEgress?.enabled === true &&
    health?.privateAssetEgress?.recorderConfigured === true &&
    health?.privateAssetEgress?.financeActorVerified === true,
    "PRIVATE_DOWNLOAD_ACCOUNTING_NOT_READY");

  const billing = health?.billing || {};
  check("billingConfiguration", billing.enabled === true &&
    (billing.providerKeyConfigured === true) &&
    (billing.webhookSecretConfigured === true),
    "BILLING_WEBHOOK_CONFIGURATION_NOT_READY");

  for (const [key, code] of REQUIRED_EVIDENCE) {
    check(key, recentTimestamp(evidence[key], now), code);
  }

  const uniqueBlockers = [...new Set(blockers)];
  return Object.freeze({
    launchAllowed: uniqueBlockers.length === 0,
    decision: uniqueBlockers.length === 0 ? "READY_FOR_CONTROLLED_LAUNCH_REVIEW" : "BLOCKED",
    evaluatedAt: new Date(now).toISOString(),
    checks: Object.freeze(checks),
    blockers: Object.freeze(uniqueBlockers),
    evidencePolicy: Object.freeze({
      maxAgeDays: MAX_EVIDENCE_AGE_MS / (24 * 60 * 60 * 1000),
      operatorAttestationsAreNotAutomatedProviderProof: true
    })
  });
}
