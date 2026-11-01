import test from "node:test";
import assert from "node:assert/strict";
import {
  assertVideoCapabilities,
  createMockVideoGenerationAdapter,
  createVideoRequestProvenance,
  normalizeVideoGenerationRequest,
  VideoGenerationValidationError,
} from "../video-generation-contract.mjs";

const base = { projectId: "project-1", prompt: "A cinematic wide shot at sunrise" };

test("normalizes defaults and generates a request ID", () => {
  const request = normalizeVideoGenerationRequest(base);
  assert.equal(request.projectId, "project-1");
  assert.equal(request.aspectRatio, "16:9");
  assert.equal(request.resolution, "720p");
  assert.equal(request.durationSeconds, 5);
  assert.equal(request.audioMode, "provider_default");
  assert.ok(request.requestId);
  assert.deepEqual(request.referenceAssetIds, []);
});

test("rejects malformed requests and unsafe bounds", () => {
  for (const input of [
    null,
    {},
    { ...base, durationSeconds: 0 },
    { ...base, durationSeconds: 181 },
    { ...base, seed: 1.5 },
    { ...base, aspectRatio: "square-ish" },
    { ...base, referenceAssetIds: ["asset-a", "asset-a"] },
    { ...base, referenceAssetIds: Array.from({ length: 13 }, (_, i) => `asset-${i}`) },
    { ...base, prompt: "x".repeat(12001) },
  ]) {
    assert.throws(() => normalizeVideoGenerationRequest(input), VideoGenerationValidationError);
  }
});

test("fails closed when a provider lacks a requested capability", () => {
  const request = normalizeVideoGenerationRequest({ ...base, startFrameAssetId: "frame-1" });
  assert.throws(
    () => assertVideoCapabilities(request, { startFrame: false }),
    (error) => error.code === "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY",
  );
});

test("accepts explicitly declared capabilities", () => {
  const request = normalizeVideoGenerationRequest({
    ...base,
    seed: 42,
    startFrameAssetId: "frame-start",
    endFrameAssetId: "frame-end",
    referenceAssetIds: ["character-ref"],
    audioMode: "none",
  });
  assert.equal(assertVideoCapabilities(request, {
    seed: true,
    startFrame: true,
    endFrame: true,
    referenceImages: true,
    audioModes: ["none"],
    aspectRatios: ["16:9"],
    resolutions: ["720p"],
    minDurationSeconds: 1,
    maxDurationSeconds: 10,
  }), true);
});

test("mock adapter accepts a job without network or fabricated media output", async () => {
  const adapter = createMockVideoGenerationAdapter();
  const submitted = await adapter.submit(base);
  assert.equal(submitted.status, "queued");
  assert.equal(submitted.mock, true);
  assert.match(submitted.jobId, /^mock-/);
  const status = await adapter.getStatus(submitted.jobId);
  assert.equal(status.status, "succeeded");
  assert.equal(status.output, null);
  assert.equal(status.mock, true);
});

test("mock adapter rejects unsupported resolution instead of silently downgrading", async () => {
  const adapter = createMockVideoGenerationAdapter();
  await assert.rejects(
    () => adapter.submit({ ...base, resolution: "2160p" }),
    (error) => error.code === "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY",
  );
});

test("provenance records a stable request hash and provider identity", () => {
  const first = createVideoRequestProvenance({ ...base, requestId: "req-1" }, { provider: "mock", model: "mock-video-v1" });
  const second = createVideoRequestProvenance({ ...base, requestId: "req-1" }, { provider: "mock", model: "mock-video-v1" });
  assert.equal(first.requestHash, second.requestHash);
  assert.equal(first.provider, "mock");
  assert.equal(first.model, "mock-video-v1");
  assert.match(first.requestHash, /^[a-f0-9]{64}$/);
});
