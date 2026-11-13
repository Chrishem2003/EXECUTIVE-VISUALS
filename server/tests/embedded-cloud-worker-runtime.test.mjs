import test from "node:test";
import assert from "node:assert/strict";
import { startEmbeddedCloudWorker } from "../embedded-cloud-worker-runtime.mjs";

test("embedded cloud worker remains disabled by default without invoking startup", async () => {
  let called = false;
  const result = await startEmbeddedCloudWorker({ env: {}, start: async () => { called = true; } });
  assert.equal(result, null);
  assert.equal(called, false);
});

test("embedded cloud worker requires both explicit worker enablement gates", async () => {
  await assert.rejects(
    startEmbeddedCloudWorker({ env: { CLOUD_WORKER_IN_PROCESS_ENABLED: "true" }, start: async () => ({ stop() {} }) }),
    /CLOUD_WORKER_ENABLED=true and CLOUD_VIDEO_WORKER_ENABLED=true/
  );
});

test("embedded mode refuses CPU-heavy media and timeline worker families", async () => {
  const base = {
    CLOUD_WORKER_IN_PROCESS_ENABLED: "true",
    CLOUD_WORKER_ENABLED: "true",
    CLOUD_VIDEO_WORKER_ENABLED: "true"
  };
  await assert.rejects(
    startEmbeddedCloudWorker({ env: { ...base, CLOUD_MEDIA_WORKER_ENABLED: "true" }, start: async () => ({ stop() {} }) }),
    /media and timeline workers must remain separate/
  );
  await assert.rejects(
    startEmbeddedCloudWorker({ env: { ...base, CLOUD_TIMELINE_WORKER_ENABLED: "true" }, start: async () => ({ stop() {} }) }),
    /media and timeline workers must remain separate/
  );
});

test("embedded cloud worker starts only after explicit opt-in and exposes graceful stop", async () => {
  let starts = 0, stops = 0;
  const worker = await startEmbeddedCloudWorker({
    env: {
      CLOUD_WORKER_IN_PROCESS_ENABLED: "true",
      CLOUD_WORKER_ENABLED: "true",
      CLOUD_VIDEO_WORKER_ENABLED: "true"
    },
    start: async () => { starts++; return { async stop() { stops++; } }; }
  });
  assert.equal(worker.active, true);
  assert.equal(starts, 1);
  await worker.stop();
  assert.equal(stops, 1);
});

test("embedded cloud worker propagates startup failures and rejects invalid supervisors", async () => {
  const env = {
    CLOUD_WORKER_IN_PROCESS_ENABLED: "true",
    CLOUD_WORKER_ENABLED: "true",
    CLOUD_VIDEO_WORKER_ENABLED: "true"
  };
  await assert.rejects(startEmbeddedCloudWorker({ env, start: async () => { throw new Error("credentials missing"); } }), /credentials missing/);
  await assert.rejects(startEmbeddedCloudWorker({ env, start: async () => ({}) }), /stoppable supervisor/);
});
