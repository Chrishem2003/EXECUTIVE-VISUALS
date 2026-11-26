import test from "node:test";
import assert from "node:assert/strict";
import { evaluateProductionLaunchGate } from "../production-launch-gate.mjs";

const now = Date.parse("2026-11-26T12:00:00.000Z");
const evidence = {
  privateBucketVerifiedAt: "2026-11-26T10:00:00.000Z",
  workerHeartbeatVerifiedAt: "2026-11-26T10:00:00.000Z",
  backupRestoreVerifiedAt: "2026-11-25T10:00:00.000Z",
  monitoringAlertVerifiedAt: "2026-11-26T09:00:00.000Z"
};
const healthy = {
  status: "ok", authMode: "supabase", authSession: { configurationReady: true },
  database: "postgres",
  creativeArtifacts: { ready: true, durableAcrossDeploys: true },
  cloudMedia: { enabled: true, ready: true, storage: "private" },
  cloudVideoWorker: { enabled: true, remoteExecutionGates: true,
    supabaseCredentialsConfigured: true, outputHostAllowlistConfigured: true,
    runtimeMode: "separate-process" },
  privateAssetEgress: { enabled: true, recorderConfigured: true, financeActorVerified: true },
  billing: { enabled: true, providerKeyConfigured: true, webhookSecretConfigured: true }
};

test("launch gate passes only when runtime and fresh operational evidence are present", () => {
  const result = evaluateProductionLaunchGate({ health: healthy, evidence, now });
  assert.equal(result.launchAllowed, true);
  assert.deepEqual(result.blockers, []);
});

test("SQLite and local storage cannot pass the production launch gate", () => {
  const result = evaluateProductionLaunchGate({
    health: { ...healthy, database: "sqlite", cloudMedia: { enabled: true, ready: false, storage: "unverified" } },
    evidence, now
  });
  assert.equal(result.launchAllowed, false);
  assert.ok(result.blockers.includes("DURABLE_DATABASE_NOT_VERIFIED"));
  assert.ok(result.blockers.includes("PRIVATE_CLOUD_STORAGE_NOT_VERIFIED"));
});

test("a reachable health endpoint cannot substitute for worker, restore or monitoring evidence", () => {
  const result = evaluateProductionLaunchGate({
    health: { ...healthy, cloudVideoWorker: { ...healthy.cloudVideoWorker, enabled: false } },
    evidence: {}, now
  });
  assert.ok(result.blockers.includes("DURABLE_WORKER_CONFIGURATION_NOT_READY"));
  assert.ok(result.blockers.includes("BACKUP_RESTORE_VERIFICATION_MISSING"));
  assert.ok(result.blockers.includes("MONITORING_ALERT_VERIFICATION_MISSING"));
});

test("stale or future-dated operator evidence is rejected", () => {
  const result = evaluateProductionLaunchGate({
    health: healthy,
    evidence: { ...evidence, backupRestoreVerifiedAt: "2026-11-01T10:00:00.000Z",
      privateBucketVerifiedAt: "2026-12-01T10:00:00.000Z" }, now
  });
  assert.ok(result.blockers.includes("BACKUP_RESTORE_VERIFICATION_MISSING"));
  assert.ok(result.blockers.includes("PRIVATE_BUCKET_VERIFICATION_MISSING"));
});
