import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleGeminiGcsMirrorRecoveryMaintenanceTask } from "../cloud-worker-process.mjs";

test("GCS recovery maintenance verifies workload identity before constructing the mirror service", async () => {
  const calls = [];
  const cloudCredentials = { url: "https://staging.example.invalid", serviceRoleKey: "server-only" };
  const task = await createGoogleGeminiGcsMirrorRecoveryMaintenanceTask({
    env: { GEMINI_GCS_MIRROR_RECOVERY_ENABLED: "true" },
    cloudCredentials,
    fetchImpl: async () => new Response("{}", { status: 200 }),
    maxBytes: 1024,
    async createBootstrap(options) {
      calls.push(["bootstrap", options.env.GEMINI_GCS_MIRROR_RECOVERY_ENABLED]);
      return {
        async checkIdentity() {
          calls.push(["identity"]);
          return { ready: true, identityMode: "external-account-wif" };
        },
        createService(options) {
          calls.push(["service", options.url, options.serviceRoleKey, options.maxBytes]);
          return {
            async recoverMirrorAttempts({ limit }) {
              calls.push(["recover", limit]);
              return { scanned: 2, reconciled: 1 };
            }
          };
        }
      };
    }
  });

  assert.deepEqual(calls, [
    ["bootstrap", "true"],
    ["identity"],
    ["service", cloudCredentials.url, cloudCredentials.serviceRoleKey, 1024]
  ]);
  assert.deepEqual(await task.run(), { scanned: 2, reconciled: 1 });
  assert.deepEqual(calls.at(-1), ["recover", 100]);
});

test("GCS recovery refuses to construct a service when workload identity is not verified", async () => {
  let serviceConstructed = false;
  await assert.rejects(createGoogleGeminiGcsMirrorRecoveryMaintenanceTask({
    env: {},
    createBootstrap: async () => ({
      async checkIdentity() { return { ready: false }; },
      createService() { serviceConstructed = true; return {}; }
    })
  }), /identity verification did not confirm readiness/);
  assert.equal(serviceConstructed, false);
});

test("GCS recovery refuses malformed bootstrap contracts", async () => {
  await assert.rejects(createGoogleGeminiGcsMirrorRecoveryMaintenanceTask({
    env: {},
    createBootstrap: async () => ({ checkIdentity: async () => ({ ready: true }) })
  }), /identity verification and a service factory/);
});
