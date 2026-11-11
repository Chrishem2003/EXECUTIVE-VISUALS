import test from "node:test";
import assert from "node:assert/strict";
import { createProviderAwareCloudVideoWorker } from "../cloud-video-provider-worker.mjs";

const adapter = (provider, model) => ({
  provider, model,
  async submit() { throw new Error("not expected in composition test"); },
  async getStatus() { throw new Error("not expected in composition test"); },
  async ingestOutputs() { return { assetIds: [] }; },
  async resolveActualCost() { return null; }
});
const queue = {
  async claim() { return null; },
  async renew() { return true; },
  async assertLease() { return true; }
};
const enqueue = {
  async finish() { return true; },
  async defer() { return true; },
  async quarantine() { return true; },
  async recoverExpiredVideo() { return 0; }
};
const ledger = {
  async prepare() {}, async begin() {}, async record() {}, async markUnknown() {}
};

test("composes multiple exact-match adapters without provider or database I/O", async () => {
  const worker = createProviderAwareCloudVideoWorker({
    workerId: "shared-video-worker",
    queue, enqueue, ledger,
    adapters: [
      adapter("runway", "gen4.5"),
      adapter("fal", "fal-ai/wan/v2.7/text-to-video")
    ]
  });
  assert.deepEqual(worker.listSupported(), [
    "fal:fal-ai/wan/v2.7/text-to-video",
    "runway:gen4.5"
  ]);
  assert.deepEqual(await worker.runCycle(), { claimed: false });
  assert.equal(await worker.recoverExpired(), 0);
});

test("rejects adapters without provider-specific private ingestion and cost evidence", () => {
  assert.throws(() => createProviderAwareCloudVideoWorker({
    workerId: "worker", queue, enqueue, ledger,
    adapters: [{ ...adapter("fal", "fal-ai/wan"), resolveActualCost: undefined }]
  }), /private output ingestion and authoritative cost reconciliation/);
});

test("rejects empty adapter registries before constructing a worker", () => {
  assert.throws(() => createProviderAwareCloudVideoWorker({
    workerId: "worker", queue, enqueue, ledger, adapters: []
  }), /between 1 and 100 adapters/);
});
