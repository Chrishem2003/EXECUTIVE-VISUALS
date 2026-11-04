import test from "node:test";
import assert from "node:assert/strict";
import { createLumaRay32Adapter } from "../luma-ray32-video-adapter.mjs";

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(body); } };
}

test("Luma adapter submits Ray 3.2 text-to-video and polls into normalized output", async () => {
  const calls = [];
  const adapter = createLumaRay32Adapter({
    apiKey: "test-secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (init.method === "POST") return response({ id: "gen_12345678", state: "queued", model: "ray-3.2" }, 201);
      return response({
        id: "gen_12345678", state: "completed",
        output: [{ type: "video", url: "https://cdn.example.test/out.mp4?sig=temporary" }],
        usage: { credits_charged: 100 }
      });
    }
  });
  const payload = await adapter.prepareInput({ prompt: "A cinematic aerial view", durationSeconds: 5, resolution: "720p", aspectRatio: "16:9" });
  assert.deepEqual(payload, {
    model: "ray-3.2", type: "video", prompt: "A cinematic aerial view",
    aspect_ratio: "16:9", video: { resolution: "720p", duration: "5s" }
  });
  const submitted = await adapter.submit(payload);
  assert.deepEqual(submitted, { taskId: "gen_12345678", status: "queued" });
  const status = await adapter.getStatus(submitted.taskId);
  assert.equal(status.status, "succeeded");
  assert.equal(status.outputUrls[0], "https://cdn.example.test/out.mp4?sig=temporary");
  assert.equal(status.usage.credits_charged, 100);
  assert.equal(calls[0].url, "https://agents.lumalabs.ai/v1/generations");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-secret");
  assert.equal(calls[1].url, "https://agents.lumalabs.ai/v1/generations/gen_12345678");
});

test("Luma adapter supports first/last anchors and up to 64 indexed keyframes", async () => {
  const adapter = createLumaRay32Adapter({ apiKey: "test-secret", fetchImpl: async () => response({ id: "gen_12345678", state: "queued" }, 201) });
  const anchored = await adapter.prepareInput({
    prompt: "Animate between two images", durationSeconds: 5, startFrame: { url: "https://assets.example.test/first.png" },
    endFrame: { file_id: "file_123" }
  });
  assert.deepEqual(anchored.video.start_frame, { url: "https://assets.example.test/first.png" });
  assert.deepEqual(anchored.video.end_frame, { file_id: "file_123" });
  const keyframes = Array.from({ length: 64 }, (_, i) => ({ file_id: "frame_" + i }));
  const indexes = Array.from({ length: 64 }, (_, i) => i);
  const multi = await adapter.prepareInput({ prompt: "Keyframed sequence", durationSeconds: 5, keyframes, keyframeIndexes: indexes });
  assert.equal(multi.video.keyframes.length, 64);
  assert.equal(multi.video.keyframe_indexes[63], 63);
  const hdrTenSecond = await adapter.prepareInput({
    prompt: "Ten second HDR multi-keyframe sequence", durationSeconds: 10,
    resolution: "1080p", hdr: true, keyframes: [{ file_id: "hdr-frame-1" }],
    keyframeIndexes: [0]
  });
  assert.equal(hdrTenSecond.video.duration, "10s");
  assert.equal(hdrTenSecond.video.hdr, true);
});

test("Luma adapter rejects unsupported duration, anchor conflicts and unsafe media URLs before POST", async () => {
  const adapter = createLumaRay32Adapter({ apiKey: "test-secret", fetchImpl: async () => { throw new Error("must not call network"); } });
  await assert.rejects(adapter.prepareInput({ prompt: "bad", durationSeconds: 7 }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
  await assert.rejects(adapter.prepareInput({ prompt: "bad", durationSeconds: 10, startFrame: { url: "https://assets.example.test/a.png" } }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
  await assert.rejects(adapter.prepareInput({ prompt: "bad", startFrame: { url: "http://127.0.0.1/private.png" } }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
  await assert.rejects(adapter.prepareInput({ prompt: "bad", keyframes: [{ file_id: "x" }], keyframeIndexes: [0], loop: true }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
});

test("Luma adapter validates completed output URLs and reports provider failures", async () => {
  let body = { id: "gen_12345678", state: "completed", output: [{ type: "video", url: "http://evil.example/out.mp4" }] };
  const adapter = createLumaRay32Adapter({ apiKey: "test-secret", fetchImpl: async () => response(body) });
  await assert.rejects(adapter.getStatus("gen_12345678"), error => error.code === "LUMA_VIDEO_OUTPUT_INVALID");
  body = { id: "gen_12345678", state: "failed", failure_reason: "moderation rejected", failure_code: "CONTENT_POLICY" };
  const failed = await adapter.getStatus("gen_12345678");
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureCode, "CONTENT_POLICY");
});

test("Luma adapter requires server credentials and bounds generation identifiers", async () => {
  assert.throws(() => createLumaRay32Adapter({ apiKey: "" }), error => error.code === "LUMA_VIDEO_CONFIGURATION_MISSING");
  const adapter = createLumaRay32Adapter({ apiKey: "test-secret", fetchImpl: async () => response({}) });
  await assert.rejects(adapter.getStatus("../secret"), error => error.code === "LUMA_VIDEO_TASK_ID_INVALID");
});

test("Luma adapter rejects malformed boolean controls, untrusted API origins and mismatched task records", async () => {
  assert.throws(() => createLumaRay32Adapter({
    apiKey: "test-secret", baseUrl: "https://attacker.example/v1",
    fetchImpl: async () => response({})
  }), error => error.code === "LUMA_VIDEO_ADAPTER_ERROR");
  const adapter = createLumaRay32Adapter({
    apiKey: "test-secret",
    fetchImpl: async () => response({ id: "gen_other123", state: "queued" })
  });
  await assert.rejects(adapter.prepareInput({ prompt: "invalid control", hdr: "true" }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
  await assert.rejects(adapter.getStatus("gen_12345678"), error => error.code === "LUMA_VIDEO_RESPONSE_MISMATCH");
});
