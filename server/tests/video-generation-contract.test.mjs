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
  assert.equal(request.resolution, "provider_default");
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
    { ...base, durationSeconds: 1.5 },
    { ...base, durationSeconds: 181 },
    { ...base, seed: 1.5 },
    { ...base, projectId: 42 },
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
    resolution: "720p",
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


test("allows owner-scoped generation without a project workspace", () => {
  const request = normalizeVideoGenerationRequest({ prompt: "Standalone short film" });
  assert.equal(request.projectId, undefined);
  assert.equal(createVideoRequestProvenance(request, { provider: "fal", model: "example/model" }).projectId, undefined);
});

test("rejects resolution or audio settings the configured adapter cannot honor", () => {
  const highResolution = normalizeVideoGenerationRequest({ ...base, resolution: "1080p" });
  assert.throws(() => assertVideoCapabilities(highResolution, { resolutions: ["provider_default"] }),
    (error) => error.code === "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
  const noAudio = normalizeVideoGenerationRequest({ ...base, audioMode: "none" });
  assert.throws(() => assertVideoCapabilities(noAudio, { audioModes: [] }),
    (error) => error.code === "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
});

test("accepts the documented unsigned 32-bit provider seed range",()=>{
  const request=normalizeVideoGenerationRequest({...base,seed:4294967295});
  assert.equal(request.seed,4294967295);
  assert.throws(()=>normalizeVideoGenerationRequest({...base,seed:4294967296}),VideoGenerationValidationError);
});

test("normalizes video-to-video source assets and ordered keyframe asset references", () => {
  const request = normalizeVideoGenerationRequest({
    ...base, operation: "video-to-video", sourceVideoAssetId: "source-video",
    keyframes: [{ assetId: "frame-1", at: 2.5 }, { assetId: "frame-2", at: 7 }],
    durationSeconds: 12
  });
  assert.equal(request.operation, "video-to-video");
  assert.equal(request.sourceVideoAssetId, "source-video");
  assert.deepEqual(request.keyframes, [{ assetId: "frame-1", at: 2.5 }, { assetId: "frame-2", at: 7 }]);
  assert.throws(() => normalizeVideoGenerationRequest({
    ...base, operation: "video-to-video", sourceVideoAssetId: "source-video",
    keyframes: [{ assetId: "frame-1", at: 5 }, { assetId: "frame-2", at: 2 }]
  }), VideoGenerationValidationError);
  assert.throws(() => normalizeVideoGenerationRequest({
    ...base, operation: "video-to-video", sourceVideoAssetId: "source-video",
    keyframeAssetIds: ["frame-1"]
  }), VideoGenerationValidationError);
});

test("normalizes prompt-free video upscale controls and defaults to 2k", () => {
  const request = normalizeVideoGenerationRequest({
    operation: "video-upscale", sourceVideoAssetId: "source-video",
    outputFrames: 900, creativity: 25, sharpen: 60, smartGrain: 10,
    flavor: "vivid", fpsBoost: true, durationSeconds: 30
  });
  assert.equal(request.prompt, undefined);
  assert.equal(request.resolution, "2k");
  assert.equal(request.outputFrames, 900);
  assert.equal(request.fpsBoost, true);
  assert.equal(request.flavor, "vivid");
});

test("requires a source asset for video editing and rejects invalid upscale controls", () => {
  assert.throws(() => normalizeVideoGenerationRequest({
    operation: "video-to-video", prompt: "Edit this clip"
  }), VideoGenerationValidationError);
  assert.throws(() => normalizeVideoGenerationRequest({
    operation: "video-upscale", sourceVideoAssetId: "source", creativity: 101
  }), VideoGenerationValidationError);
  assert.throws(() => normalizeVideoGenerationRequest({
    operation: "video-to-video", prompt: "Edit this clip",
    sourceVideoAssetId: "source", keyframeAssetIds: Array.from({ length: 6 }, (_, i) => "frame-" + i)
  }), VideoGenerationValidationError);
});


test("normalizes HDR conversion as a source-video operation without requiring a prompt", () => {
  const request = normalizeVideoGenerationRequest({
    operation: "video-to-hdr", sourceVideoAssetId: "source-hdr", durationSeconds: 15,
    outputFormat: "hlg"
  });
  assert.equal(request.operation, "video-to-hdr");
  assert.equal(request.prompt, undefined);
  assert.equal(request.outputFormat, "hlg");
  assert.equal(request.sourceVideoAssetId, "source-hdr");
});

test("normalizes typed private reference assets with provider-aware bounds", () => {
  const request = normalizeVideoGenerationRequest({
    ...base,
    referenceImageAssetIds: ["image-1", "image-2"],
    referenceVideoAssetIds: ["video-1"],
    referenceAudioAssetIds: ["audio-1"],
    audioMode: "reference"
  });
  assert.deepEqual(request.referenceAssetIds, ["image-1", "image-2"]);
  assert.deepEqual(request.referenceVideoAssetIds, ["video-1"]);
  assert.deepEqual(request.referenceAudioAssetIds, ["audio-1"]);
  assert.equal(assertVideoCapabilities(request, {
    referenceImages: true, referenceVideos: true, referenceAudio: true,
    audioModes: ["reference"], aspectRatios: ["16:9"], resolutions: ["provider_default"]
  }), true);
  assert.throws(() => normalizeVideoGenerationRequest({ ...base, referenceAudioAssetIds: ["audio-1", "audio-2"] }), VideoGenerationValidationError);
  assert.throws(() => normalizeVideoGenerationRequest({ ...base, referenceVideoAssetIds: Array.from({ length: 3 }, (_, i) => "video-" + i) }), VideoGenerationValidationError);
});

test("fails closed when a provider does not declare typed reference media support", () => {
  const request = normalizeVideoGenerationRequest({
    ...base, referenceVideoAssetIds: ["video-1"], referenceAudioAssetIds: ["audio-1"]
  });
  assert.throws(() => assertVideoCapabilities(request, {
    referenceVideos: false, referenceAudio: false, audioModes: ["provider_default"]
  }), error => error.code === "VIDEO_GENERATION_UNSUPPORTED_CAPABILITY");
});


test("source video counts toward the two-video Runway Router limit", () => {
  const sourceVideoAssetId = "source-video";
  assert.throws(() => normalizeVideoGenerationRequest({
    ...base, operation: "video-to-video", sourceVideoAssetId,
    referenceVideoAssetIds: ["ref-1", "ref-2"]
  }), VideoGenerationValidationError);
  assert.throws(() => normalizeVideoGenerationRequest({
    ...base, operation: "video-to-video", sourceVideoAssetId,
    referenceVideoAssetIds: [sourceVideoAssetId]
  }), VideoGenerationValidationError);
  const request = normalizeVideoGenerationRequest({
    ...base, operation: "video-to-video", sourceVideoAssetId,
    referenceVideoAssetIds: ["ref-1"]
  });
  assert.equal(request.referenceVideoAssetIds.length + 1, 2);
});

