import test from "node:test";
import assert from "node:assert/strict";
import { createCloudVideoWorkerComposition } from "../cloud-video-worker-composition.mjs";

const baseEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-server-role-only",
  RUNWAY_API_KEY: "test-runway-key-only",
  RUNWAY_VIDEO_ENABLED: "true",
  RUNWAY_VIDEO_ALLOW_REMOTE: "true"
};

test("cloud video composition rejects missing server credentials and provider opt-in", () => {
  assert.throws(() => createCloudVideoWorkerComposition({
    env: { ...baseEnv, SUPABASE_SERVICE_ROLE_KEY: "" },
    workerId: "video-test", outputHosts: ["cdn.example.com"]
  }), /Supabase credentials/);
  assert.throws(() => createCloudVideoWorkerComposition({
    env: { ...baseEnv, RUNWAY_VIDEO_ALLOW_REMOTE: "false" },
    workerId: "video-test", outputHosts: ["cdn.example.com"]
  }), /explicit Runway remote-execution opt-in/);
});

test("cloud video composition rejects wildcard or missing output host allowlists", () => {
  for (const outputHosts of [[], ["*.example.com"], ["https://cdn.example.com"], ["127.0.0.1"], ["localhost"]]) {
    assert.throws(() => createCloudVideoWorkerComposition({
      env: baseEnv, workerId: "video-test", outputHosts
    }), /exact-host output allowlist/);
  }
});

test("cloud video composition wires the server-only worker graph without making provider or database requests", () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; throw new Error("network must not be used during composition"); };
  const worker = createCloudVideoWorkerComposition({
    env: baseEnv,
    workerId: "video-test",
    outputHosts: ["cdn.example.com", "media.example.com"],
    maxBytes: 1024 * 1024,
    fetchImpl
  });
  assert.equal(typeof worker.runCycle, "function");
  assert.equal(typeof worker.recoverExpired, "function");
  assert.equal(requests, 0);
});
