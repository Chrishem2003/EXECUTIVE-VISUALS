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
      if (init.method === "POST") return response({ id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e", state: "queued", model: "ray-3.2" }, 201);
      return response({
        id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e", state: "completed",
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
  const attributed = await adapter.prepareInput({
    prompt: "A cinematic aerial view", user_id: "opaque-owner-123"
  });
  assert.equal(attributed.user_id, "opaque-owner-123");
  await assert.rejects(adapter.prepareInput({
    prompt: "A cinematic aerial view", user_id: "x".repeat(257)
  }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
  const submitted = await adapter.submit(payload);
  assert.deepEqual(submitted, { taskId: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e", status: "queued" });
  const status = await adapter.getStatus(submitted.taskId);
  assert.equal(status.status, "succeeded");
  assert.equal(status.outputUrls[0], "https://cdn.example.test/out.mp4?sig=temporary");
  assert.equal(status.usage.credits_charged, 100);
  assert.equal(calls[0].url, "https://agents.lumalabs.ai/v1/generations");
  assert.equal(calls[0].init.headers.authorization, "Bearer test-secret");
  assert.equal(calls[1].url, "https://agents.lumalabs.ai/v1/generations/182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e");
});

test("Luma adapter supports first/last anchors and up to 64 indexed keyframes", async () => {
  const adapter = createLumaRay32Adapter({ apiKey: "test-secret", fetchImpl: async () => response({ id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e", state: "queued" }, 201) });
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
  await assert.rejects(adapter.prepareInput({
    prompt: "Ten second HDR multi-keyframe sequence", durationSeconds: 10,
    resolution: "1080p", hdr: true, keyframes: [{ file_id: "hdr-frame-1" }],
    keyframeIndexes: [0]
  }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
});

test("Luma adapter rejects unsupported duration, anchor conflicts and unsafe media URLs before POST", async () => {
  const adapter = createLumaRay32Adapter({ apiKey: "test-secret", fetchImpl: async () => { throw new Error("must not call network"); } });
  await assert.rejects(adapter.prepareInput({ prompt: "bad", durationSeconds: 7 }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
  await assert.rejects(adapter.prepareInput({ prompt: "bad", durationSeconds: 10, startFrame: { url: "https://assets.example.test/a.png" } }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
  await assert.rejects(adapter.prepareInput({ prompt: "bad", startFrame: { url: "http://127.0.0.1/private.png" } }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
  await assert.rejects(adapter.prepareInput({ prompt: "bad", keyframes: [{ file_id: "x" }], keyframeIndexes: [0], loop: true }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
});

test("Luma adapter validates completed output URLs and reports provider failures", async () => {
  let body = { id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e", state: "completed", output: [{ type: "video", url: "http://evil.example/out.mp4" }] };
  const adapter = createLumaRay32Adapter({ apiKey: "test-secret", fetchImpl: async () => response(body) });
  await assert.rejects(adapter.getStatus("182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e"), error => error.code === "LUMA_VIDEO_OUTPUT_INVALID");
  body = { id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e", state: "failed", failure_reason: "moderation rejected", failure_code: "CONTENT_POLICY" };
  const failed = await adapter.getStatus("182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e");
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
    fetchImpl: async () => response({ id: "182bd5e5-6e1a-4fe4-b799-aa6d9a6ab26e", state: "queued" })
  });
  await assert.rejects(adapter.prepareInput({ prompt: "invalid control", hdr: "true" }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
  await assert.rejects(adapter.getStatus("182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e"), error => error.code === "LUMA_VIDEO_RESPONSE_MISMATCH");
});


test("Luma completed jobs remain pollable until credits settle, with bounded exponential retry", async () => {
  let now = Date.parse("2026-11-15T15:00:00.000Z");
  let body = {
    id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
    state: "completed",
    created_at: "2026-11-15T14:59:00.000Z",
    output: [{ type: "video", url: "https://cdn.example.test/out.mp4?sig=temporary" }],
    usage: { credits_charged: null }
  };
  const adapter = createLumaRay32Adapter({
    apiKey: "test-secret",
    now: () => now,
    billingSettlementMaxWaitMs: 600000,
    fetchImpl: async () => response(body)
  });
  const pending = await adapter.getStatus("182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e", { job: { attempt_count: 3 } });
  assert.equal(pending.status, "running");
  assert.equal(pending.providerState, "completed_billing_pending");
  assert.equal(pending.billingPending, true);
  assert.equal(pending.retryAfterSeconds, 120);
  body = { ...body, usage: { credits_charged: 100 } };
  const settled = await adapter.getStatus("182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e");
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.usage.credits_charged, 100);
  assert.equal(settled.outputUrls.length, 1);
  now += 11 * 60 * 1000;
  body = { ...body, usage: { credits_charged: null } };
  const expired = await adapter.getStatus("182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e");
  assert.equal(expired.status, "succeeded");
  assert.equal(expired.usage.credits_charged, null);
});


test("Luma Ray 3.2 supports governed video edit and reframe request shapes", async () => {
  const adapter = createLumaRay32Adapter({ apiKey: "test-secret", fetchImpl: async () => response({}) });
  const edited = await adapter.prepareInput({
    operation: "edit", prompt: "Restyle the scene as golden-hour cinema",
    sourceVideo: { generation_id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e" },
    editStrength: "adhere_2"
  });
  assert.equal(edited.type, "video_edit");
  assert.deepEqual(edited.source, { generation_id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e" });
  assert.deepEqual(edited.video.edit, { strength: "adhere_2" });
  const reframed = await adapter.prepareInput({
    operation: "reframe", prompt: "Extend the environment naturally",
    sourceVideo: { file_id: "file_video_123" }, aspectRatio: "9:16", resolution: "720p"
  });
  assert.equal(reframed.type, "video_reframe");
  assert.equal(reframed.aspect_ratio, "9:16");
  assert.deepEqual(reframed.source, { file_id: "file_video_123" });
});

test("Luma Ray 3.2 supports extension from an owned prior generation", async () => {
  const adapter = createLumaRay32Adapter({ apiKey: "test-secret", fetchImpl: async () => response({}) });
  const payload = await adapter.prepareInput({
    operation: "extend", prompt: "Continue the camera movement smoothly",
    sourceGenerationId: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
    durationSeconds: 5
  });
  assert.equal(payload.type, "video");
  assert.deepEqual(payload.video.start_frame, {
    generation_id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e"
  });
});

test("Luma edit and reframe reject untyped, unsafe or incomplete source references", async () => {
  const adapter = createLumaRay32Adapter({ apiKey: "test-secret", fetchImpl: async () => response({}) });
  await assert.rejects(adapter.prepareInput({
    operation: "edit", prompt: "Restyle", sourceVideo: { url: "http://127.0.0.1/private.mp4", media_type: "video/mp4" }
  }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
  await assert.rejects(adapter.prepareInput({
    operation: "reframe", prompt: "Reframe", sourceVideo: { url: "https://cdn.example.test/source.mp4" }, aspectRatio: "9:16"
  }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
  await assert.rejects(adapter.prepareInput({
    operation: "reframe", prompt: "Reframe", sourceVideo: { file_id: "file_video_123" }
  }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
  await assert.rejects(adapter.prepareInput({
    operation: "extend", prompt: "Continue", sourceGenerationId: "../foreign"
  }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
  await assert.rejects(adapter.prepareInput({
    operation: "edit", prompt: "Restyle", sourceVideo: { generation_id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e" }, editStrength: "wild"
  }), error => error.code === "LUMA_VIDEO_INPUT_INVALID");
});


test("Luma Files API creates presigned uploads, transfers bytes without bearer credentials and completes ingestion", async () => {
  const calls = [];
  const fileId = "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e";
  const adapter = createLumaRay32Adapter({
    apiKey: "server-secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/files") && init.method === "POST") return response({
        id: fileId, file: { id: fileId, mime_type: "video/mp4", size_bytes: 4, state: "pending" },
        upload: { method: "PUT", url: "https://bucket.s3.amazonaws.com/object?signature=temporary",
          expires_at: "2026-11-16T12:00:00.000Z", headers: { "x-amz-meta-test": "ok" } }
      }, 201);
      if (url.includes("/complete")) return response({ file: { id: fileId, state: "pending" } });
      if (url.includes("/files/")) return response({ file: { id: fileId, state: "ready", mime_type: "video/mp4", size_bytes: 4 } });
      if (url.includes("s3.amazonaws.com")) return { ok: true, status: 200, async text() { return ""; } };
      throw new Error("unexpected URL");
    },
    now: () => Date.parse("2026-11-15T12:00:00.000Z")
  });
  const receipt = await adapter.createFileUpload({ mimeType: "video/mp4", sizeBytes: 4, filename: "source.mp4", purpose: "input", userId: "opaque-user" });
  assert.equal(receipt.fileId, fileId);
  assert.equal(receipt.upload.method, "PUT");
  const uploaded = await adapter.uploadFileBytes({ upload: receipt.upload, bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "video/mp4" });
  assert.equal(uploaded.uploadedBytes, 4);
  assert.equal(calls[1].init.method, "PUT");
  assert.equal(calls[1].init.headers.authorization, undefined);
  assert.equal(calls[1].init.headers["x-amz-meta-test"], "ok");
  assert.deepEqual(await adapter.completeFileUpload(fileId), { fileId, state: "pending" });
  assert.equal((await adapter.getFile(fileId)).state, "ready");
  assert.equal(calls[0].url, "https://agents.lumalabs.ai/v1/files");
  assert.equal(calls[0].init.headers.authorization, "Bearer server-secret");
});

test("Luma Files API rejects unsafe upload origins, metadata and file identifiers", async () => {
  const adapter = createLumaRay32Adapter({
    apiKey: "server-secret",
    fetchImpl: async () => response({
      id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
      file: { id: "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e", mime_type: "video/mp4", size_bytes: 4, state: "pending" },
      upload: { method: "PUT", url: "https://127.0.0.1/private", expires_at: "2026-11-16T12:00:00.000Z" }
    }),
    now: () => Date.parse("2026-11-15T12:00:00.000Z")
  });
  await assert.rejects(adapter.createFileUpload({ mimeType: "video/mp4", sizeBytes: 4 }), error => error.code === "LUMA_FILE_UPLOAD_URL_INVALID");
  await assert.rejects(adapter.createFileUpload({ mimeType: "video/mp4", sizeBytes: 0 }), error => error.code === "LUMA_FILE_INPUT_INVALID");
  await assert.rejects(adapter.createFileUpload({ mimeType: "application/pdf", sizeBytes: 4 }), error => error.code === "LUMA_FILE_INPUT_INVALID");
  await assert.rejects(adapter.getFile("../private"), error => error.code === "LUMA_FILE_ID_INVALID");
});


test("Luma file deletion accepts the documented empty 204 response and upload cannot use forged receipts", async () => {
  const fileId = "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e";
  const calls = [];
  const adapter = createLumaRay32Adapter({
    apiKey: "server-secret",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/files") && init.method === "POST") return response({
        id: fileId, file: { id: fileId, mime_type: "image/png", size_bytes: 2, state: "pending" },
        upload: { method: "PUT", url: "https://bucket.s3.amazonaws.com/object?signature=temporary",
          expires_at: "2026-11-16T12:00:00.000Z", headers: {} }
      }, 201);
      if (init.method === "DELETE") return { ok: true, status: 204, async text() { return ""; } };
      return { ok: true, status: 200, async text() { return ""; } };
    },
    now: () => Date.parse("2026-11-15T12:00:00.000Z")
  });
  const receipt = await adapter.createFileUpload({ mimeType: "image/png", sizeBytes: 2 });
  await assert.rejects(adapter.uploadFileBytes({
    upload: { ...receipt.upload }, bytes: new Uint8Array([1, 2]), mimeType: "image/png"
  }), error => error.code === "LUMA_FILE_INPUT_INVALID");
  assert.deepEqual(await adapter.deleteFile(fileId), { fileId, deleted: true });
  assert.equal(calls.at(-1).url, "https://agents.lumalabs.ai/v1/files/" + fileId);
  assert.equal(calls.at(-1).init.method, "DELETE");
});
