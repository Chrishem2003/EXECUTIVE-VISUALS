import test from "node:test";
import assert from "node:assert/strict";
import { createRunwayCloudVideoAdapter } from "../runway-cloud-video-adapter.mjs";

const id = "497f6eca-6276-4993-bfeb-53cbbbba6f08";
const output = "https://cdn.example.net/generated.mp4?token=temporary";
const base = {
  model: "gen4.5",
  apiKey: "runway-test-key",
  enabled: true,
  allowRemote: true,
  ingestOutputs: async () => ({ assetIds: ["asset-1"] }),
  resolveActualCost: async () => ({ amount: 12, currency: "USD", evidenceReference: "runway:usage-row:1" }),
  assertActualCostReady: async () => true
};

test("submits Kling 4.0 Flash text-to-video through the durable worker adapter", async () => {
  let call;
  const adapter = createRunwayCloudVideoAdapter({
    ...base,
    model: "kling_4_flash",
    fetchImpl: async (url, options) => {
      call = { url: String(url), options };
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
  });
  const result = await adapter.submit({
    provider: "runway", model: "kling_4_flash", operation: "text-to-video",
    prompt: "A cinematic city at night", durationSeconds: 5,
    aspectRatio: "16:9", resolution: "720p"
  });
  assert.equal(result.taskId, id);
  assert.equal(call.url, "https://api.dev.runwayml.com/v1/text_to_video");
  assert.deepEqual(JSON.parse(call.options.body), {
    model: "kling_4_flash", ratio: "1280:720",
    promptText: "A cinematic city at night", duration: 5
  });
});

test("enhances a Seedance draft with the exact model and draftTaskId payload", async () => {
  let call;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "seedance2_5",
    fetchImpl: async (url, options) => {
      call = { url: String(url), options };
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
  });
  const result = await adapter.submit({
    provider: "runway", model: "seedance2_5", operation: "text-to-video",
    prompt: "Stored preview prompt is intentionally not sent again",
    durationSeconds: 8, resolution: "1080p",
    draftTaskId: "223e4567-e89b-42d3-a456-426614174000"
  });
  assert.equal(result.taskId, id);
  assert.equal(call.url, "https://api.dev.runwayml.com/v1/text_to_video");
  assert.deepEqual(JSON.parse(call.options.body), {
    model: "seedance2_5", draftTaskId: "223e4567-e89b-42d3-a456-426614174000"
  });
});

test("rejects invalid Seedance draft enhancement inputs before provider submission", async () => {
  let calls = 0;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "seedance2_5",
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ id }), { status: 200 }); }
  });
  const valid = {
    provider: "runway", model: "seedance2_5", operation: "text-to-video",
    prompt: "Enhance", durationSeconds: 8, resolution: "1080p",
    draftTaskId: "223e4567-e89b-42d3-a456-426614174000"
  };
  await assert.rejects(() => adapter.submit({ ...valid, resolution: "4k" }), error => error.code === "RUNWAY_INPUT_INVALID");
  await assert.rejects(() => adapter.submit({ ...valid, draft: true }), error => error.code === "RUNWAY_INPUT_INVALID");
  await assert.rejects(() => adapter.submit({ ...valid, draftTaskId: "not-a-task-id" }), error => error.code === "RUNWAY_INPUT_INVALID");
  assert.equal(calls, 0);
});

test("submits one Gen-4.5 text-to-video task using the pinned API version", async () => {
  let call;
  const adapter = createRunwayCloudVideoAdapter({
    ...base,
    fetchImpl: async (url, options) => {
      call = { url: String(url), options };
      return new Response(JSON.stringify({ id, estimatedCost: { credits: 60 } }), { status: 200 });
    }
  });
  const result = await adapter.submit({
    provider: "runway", model: "gen4.5", prompt: "A cinematic sunrise",
    durationSeconds: 5, aspectRatio: "16:9"
  });
  assert.deepEqual(result, { taskId: id, status: "queued" });
  assert.equal(call.url, "https://api.dev.runwayml.com/v1/text_to_video");
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers.authorization, "Bearer runway-test-key");
  assert.equal(call.options.headers["X-Runway-Version"], "2024-11-06");
  assert.deepEqual(JSON.parse(call.options.body), {
    model: "gen4.5", promptText: "A cinematic sunrise", ratio: "1280:720", duration: 5
  });
});

test("maps queued, running and succeeded task states and exposes only HTTPS output URLs", async () => {
  let current = { id, status: "PENDING" };
  const adapter = createRunwayCloudVideoAdapter({ ...base, fetchImpl: async () => new Response(JSON.stringify(current)) });
  assert.equal((await adapter.getStatus(id)).status, "queued");
  current = { id, status: "RUNNING" };
  assert.equal((await adapter.getStatus(id)).status, "running");
  current = { id, status: "SUCCEEDED", output: [output] };
  assert.deepEqual(await adapter.getStatus(id), {
    status: "succeeded", taskId: id, outputUrls: [output], provider: "runway", model: "gen4.5"
  });
});

test("exposes task-level realized credits without mistaking estimates for settlement", async () => {
  const adapter = createRunwayCloudVideoAdapter({
    ...base,
    fetchImpl: async () => new Response(JSON.stringify({
      id, status: "SUCCEEDED", output: [output], cost: { credits: 137 },
      estimatedCost: { credits: 999 }
    }))
  });
  const task = await adapter.getStatus(id);
  assert.equal(task.status, "succeeded");
  assert.equal(task.actualCostCredits, 137);
  assert.notEqual(task.actualCostCredits, 999);
});

test("does not promote estimated router cost to a realized task receipt", async () => {
  const adapter = createRunwayCloudVideoAdapter({
    ...base,
    fetchImpl: async () => new Response(JSON.stringify({
      id, status: "SUCCEEDED", output: [output], estimatedCost: { credits: 137 }
    }))
  });
  const task = await adapter.getStatus(id);
  assert.equal(task.status, "succeeded");
  assert.equal(Object.hasOwn(task, "actualCostCredits"), false);
});

test("requires authoritative task-level billing evidence and private ingestion", () => {
  assert.throws(() => createRunwayCloudVideoAdapter({ model: "gen4.5", apiKey: "key", enabled: true, allowRemote: true, ingestOutputs: async () => ({}) }), error => error.code === "RUNWAY_EXECUTION_GATES_MISSING");
  assert.throws(() => createRunwayCloudVideoAdapter({ model: "gen4.5", apiKey: "key", enabled: true, allowRemote: true, resolveActualCost: async () => ({}) }), error => error.code === "RUNWAY_EXECUTION_GATES_MISSING");
});

test("rejects unsupported duration, unresolved references and remote calls without opt-in", async () => {
  const calls = [];
  const adapter = createRunwayCloudVideoAdapter({ ...base, fetchImpl: async (...args) => { calls.push(args); return new Response(JSON.stringify({ id })); } });
  await assert.rejects(() => adapter.submit({ provider: "runway", model: "gen4.5", prompt: "test", durationSeconds: 11 }), error => error.code === "VIDEO_GATEWAY_UNSUPPORTED_CAPABILITY");
  await assert.rejects(() => adapter.submit({ provider: "runway", model: "gen4.5", prompt: "test", referenceAssetIds: ["private-asset"] }), error => error.code === "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
  const disabled = createRunwayCloudVideoAdapter({ ...base, allowRemote: false, fetchImpl: async (...args) => { calls.push(args); } });
  await assert.rejects(() => disabled.submit({ provider: "runway", model: "gen4.5", prompt: "test" }), error => error.code === "RUNWAY_REMOTE_DISABLED");
  assert.equal(calls.length, 0);
});

test("does not mistake Runway's estimated credits for actual billing", async () => {
  let actualResolverCalls = 0;
  const adapter = createRunwayCloudVideoAdapter({
    ...base,
    resolveActualCost: async args => {
      actualResolverCalls += 1;
      assert.equal(args.providerTaskId, id);
      return { amount: 11, currency: "USD", evidenceReference: "runway:verified-task-ledger" };
    },
    fetchImpl: async () => new Response(JSON.stringify({ id, status: "SUCCEEDED", output: [output], estimatedCost: { credits: 60 } }))
  });
  const task = await adapter.getStatus(id);
  const cost = await adapter.resolveActualCost({ providerTaskId: id, task });
  assert.equal(cost.amount, 11);
  assert.equal(actualResolverCalls, 1);
});


test("prepares authorized source media with ephemeral uploads and submits durable Aleph2 video-to-video task", async () => {
  const calls = [];
  let uploadIndex = 0;
  const adapter = createRunwayCloudVideoAdapter({
    ...base,
    model: "aleph2",
    prepareInput: async (input, context) => {
      assert.equal(input.sourceVideoAssetId, "source-asset");
      assert.equal(context.job.owner_id, "owner-1");
      return {
        sourceVideo: { buffer: Buffer.alloc(512), filename: "source.mp4", mimeType: "video/mp4" },
        keyframes: [{ buffer: Buffer.alloc(512), filename: "guide.png", mimeType: "image/png", at: 0 }]
      };
    },
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      calls.push({ url: target, options });
      if (target.endsWith("/uploads")) {
        uploadIndex += 1;
        return new Response(JSON.stringify({
          uploadUrl: "https://uploads.runway.example/signed-" + uploadIndex,
          fields: { key: "ephemeral-" + uploadIndex },
          runwayUri: "runway://ephemeral/asset-" + uploadIndex
        }), { status: 200 });
      }
      if (target.startsWith("https://uploads.runway.example/")) return new Response(null, { status: 204 });
      if (target.endsWith("/video_to_video")) return new Response(JSON.stringify({ id }), { status: 200 });
      throw new Error("unexpected URL " + target);
    }
  });
  const input = {
    provider: "runway", model: "aleph2", operation: "video-to-video",
    prompt: "Preserve the actor and camera motion; replace the background.",
    sourceVideoAssetId: "source-asset", keyframeAssetIds: ["guide-asset"]
  };
  const prepared = await adapter.prepareInput(input, { job: { owner_id: "owner-1" } });
  assert.equal(prepared.videoUri, "runway://ephemeral/asset-1");
  assert.deepEqual(prepared.keyframes, [{ uri: "runway://ephemeral/asset-2", at: 0 }]);
  const submitted = await adapter.submit(prepared);
  assert.deepEqual(submitted, { taskId: id, status: "queued" });
  const post = calls.find(call => call.url.endsWith("/video_to_video"));
  assert.ok(post);
  assert.deepEqual(JSON.parse(post.options.body), {
    model: "aleph2", videoUri: "runway://ephemeral/asset-1",
    promptText: "Preserve the actor and camera motion; replace the background.",
    keyframes: [{ uri: "runway://ephemeral/asset-2", at: 0 }],
    outputFormat: "mp4"
  });
  assert.equal(calls.filter(call => call.url.endsWith("/uploads")).length, 2);
});

test("video-to-video requires an owner-scoped input resolver and never accepts unresolved asset IDs", async () => {
  const adapter = createRunwayCloudVideoAdapter({ ...base, model: "aleph2" });
  await assert.rejects(() => adapter.prepareInput({
    provider: "runway", model: "aleph2", operation: "video-to-video",
    prompt: "Edit source", sourceVideoAssetId: "private-asset"
  }, { job: { owner_id: "owner-1" } }), error => error.code === "VIDEO_INPUT_ASSET_RESOLUTION_REQUIRED");
});

test("Runway cloud adapter rejects video-to-video operation on Gen-4.5 text-only profile", async () => {
  const adapter = createRunwayCloudVideoAdapter(base);
  await assert.rejects(() => adapter.submit({
    provider: "runway", model: "gen4.5", operation: "video-to-video",
    prompt: "Edit source", videoUri: "runway://ephemeral/source"
  }), error => error.code === "RUNWAY_INPUT_INVALID");
});


test("prepares an authorized source and submits a durable Magnific video-upscale task", async () => {
  const calls = [];
  const adapter = createRunwayCloudVideoAdapter({
    ...base,
    model: "magnific_video_upscaler_creative",
    prepareInput: async (input, context) => {
      assert.equal(input.sourceVideoAssetId, "master-asset");
      assert.equal(context.job.owner_id, "owner-1");
      return { sourceVideo: { buffer: Buffer.alloc(512), filename: "master.mp4", mimeType: "video/mp4" } };
    },
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      calls.push({ url: target, options });
      if (target.endsWith("/uploads")) return new Response(JSON.stringify({
        uploadUrl: "https://uploads.runway.example/signed-upscale",
        fields: { key: "upscale-source" },
        runwayUri: "runway://ephemeral/upscale-source"
      }), { status: 200 });
      if (target === "https://uploads.runway.example/signed-upscale") return new Response(null, { status: 204 });
      if (target.endsWith("/video_upscale")) return new Response(JSON.stringify({ id }), { status: 200 });
      throw new Error("unexpected URL " + target);
    }
  });
  const input = {
    provider: "runway", model: "magnific_video_upscaler_creative",
    operation: "video-upscale", sourceVideoAssetId: "master-asset",
    resolution: "4k", creativity: 30, sharpen: 55, smartGrain: 10,
    flavor: "vivid", fpsBoost: true
  };
  const prepared = await adapter.prepareInput(input, { job: { owner_id: "owner-1" } });
  assert.equal(prepared.videoUri, "runway://ephemeral/upscale-source");
  const submitted = await adapter.submit(prepared);
  assert.deepEqual(submitted, { taskId: id, status: "queued" });
  const post = calls.find(call => call.url.endsWith("/video_upscale"));
  assert.ok(post);
  assert.deepEqual(JSON.parse(post.options.body), {
    model: "magnific_video_upscaler_creative",
    videoUri: "runway://ephemeral/upscale-source",
    resolution: "4k", flavor: "vivid",
    creativity: 30, sharpen: 55, smartGrain: 10, fpsBoost: true
  });
});

test("video upscale rejects invalid quality controls and mismatched model profiles", async () => {
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "magnific_video_upscaler_creative"
  });
  await assert.rejects(() => adapter.submit({
    provider: "runway", model: "magnific_video_upscaler_creative",
    operation: "video-upscale", videoUri: "runway://ephemeral/source",
    resolution: "8k"
  }), error => error.code === "RUNWAY_INPUT_INVALID");
  await assert.rejects(() => adapter.submit({
    provider: "runway", model: "magnific_video_upscaler_creative",
    operation: "video-upscale", videoUri: "runway://ephemeral/source",
    creativity: 101
  }), error => error.code === "RUNWAY_INPUT_INVALID");
});


test("prepares an owner-scoped first frame and submits Gen-4.5 image-to-video", async () => {
  const calls = [];
  const adapter = createRunwayCloudVideoAdapter({
    ...base,
    prepareInput: async (input, context) => {
      assert.equal(input.startFrameAssetId, "first-frame-asset");
      assert.equal(context.job.owner_id, "owner-1");
      return { firstFrame: { buffer: Buffer.alloc(512), filename: "first.png", mimeType: "image/png" } };
    },
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      calls.push({ url: target, options });
      if (target.endsWith("/uploads")) return new Response(JSON.stringify({
        uploadUrl: "https://uploads.runway.example/signed-frame",
        fields: { key: "first-frame" },
        runwayUri: "runway://ephemeral/first-frame"
      }), { status: 200 });
      if (target === "https://uploads.runway.example/signed-frame") return new Response(null, { status: 204 });
      if (target.endsWith("/image_to_video")) return new Response(JSON.stringify({ id }), { status: 200 });
      throw new Error("unexpected URL " + target);
    }
  });
  const input = {
    provider: "runway", model: "gen4.5", operation: "image-to-video",
    prompt: "Animate the opening frame", startFrameAssetId: "first-frame-asset",
    durationSeconds: 5, aspectRatio: "16:9"
  };
  const prepared = await adapter.prepareInput(input, { job: { owner_id: "owner-1" } });
  assert.equal(prepared.promptImageUri, "runway://ephemeral/first-frame");
  const submitted = await adapter.submit(prepared);
  assert.deepEqual(submitted, { taskId: id, status: "queued" });
  const post = calls.find(call => call.url.endsWith("/image_to_video"));
  assert.ok(post);
  assert.equal(JSON.parse(post.options.body).promptImage, "runway://ephemeral/first-frame");
});


test("prepares an authorized SDR source and submits a durable Ruby HDR task", async () => {
  const calls = [];
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "ruby",
    prepareInput: async (input, context) => {
      assert.equal(input.sourceVideoAssetId, "sdr-source");
      assert.equal(context.job.owner_id, "owner-1");
      return { sourceVideo: { buffer: Buffer.alloc(512), filename: "sdr.mp4", mimeType: "video/mp4" } };
    },
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      calls.push({ url: target, options });
      if (target.endsWith("/uploads")) return new Response(JSON.stringify({
        uploadUrl: "https://uploads.runway.example/signed-hdr",
        fields: { key: "hdr-source" },
        runwayUri: "runway://ephemeral/hdr-source"
      }), { status: 200 });
      if (target === "https://uploads.runway.example/signed-hdr") return new Response(null, { status: 204 });
      if (target.endsWith("/video_to_hdr")) return new Response(JSON.stringify({ id }), { status: 200 });
      throw new Error("unexpected URL " + target);
    }
  });
  const input = {
    provider: "runway", model: "ruby", operation: "video-to-hdr",
    sourceVideoAssetId: "sdr-source", durationSeconds: 10, outputFormat: "hlg"
  };
  const prepared = await adapter.prepareInput(input, { job: { owner_id: "owner-1" } });
  assert.equal(prepared.videoUri, "runway://ephemeral/hdr-source");
  assert.deepEqual(await adapter.submit(prepared), { taskId: id, status: "queued" });
  const post = calls.find(call => call.url.endsWith("/video_to_hdr"));
  assert.ok(post);
  assert.deepEqual(JSON.parse(post.options.body), {
    model: "ruby", videoUri: "runway://ephemeral/hdr-source", outputFormat: "hlg"
  });
});


test("submits Seedance 2.5 text-to-video through the durable worker adapter with model-specific payload", async () => {
  let call;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "seedance2_5",
    fetchImpl: async (url, options) => {
      call = { url: String(url), options };
      return new Response(JSON.stringify({ id, estimatedCost: { credits: 80 } }), { status: 200 });
    }
  });
  const submitted = await adapter.submit({
    provider: "runway", model: "seedance2_5", operation: "text-to-video",
    prompt: "A cinematic dawn over a quiet city", durationSeconds: 8,
    aspectRatio: "16:9", resolution: "720p"
  });
  assert.deepEqual(submitted, { taskId: id, status: "queued" });
  assert.equal(call.url, "https://api.dev.runwayml.com/v1/text_to_video");
  assert.deepEqual(JSON.parse(call.options.body), {
    model: "seedance2_5", promptText: "A cinematic dawn over a quiet city",
    ratio: "1280:720", duration: 8
  });
});

test("submits Seedance 2.5 draft text-to-video at the fixed 480p preview tier", async () => {
  let call;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "seedance2_5",
    fetchImpl: async (url, options) => {
      call = { url: String(url), options };
      return new Response(JSON.stringify({ id, estimatedCost: { credits: 160 } }), { status: 200 });
    }
  });
  const submitted = await adapter.submit({
    provider: "runway", model: "seedance2_5", operation: "text-to-video",
    prompt: "A cinematic dawn over a quiet city", durationSeconds: 8,
    aspectRatio: "16:9", resolution: "480p", draft: true
  });
  assert.deepEqual(submitted, { taskId: id, status: "queued" });
  assert.equal(call.url, "https://api.dev.runwayml.com/v1/text_to_video");
  assert.deepEqual(JSON.parse(call.options.body), {
    model: "seedance2_5", promptText: "A cinematic dawn over a quiet city",
    ratio: "1280:720", duration: 8, draft: true
  });
});

test("prepares a private first frame and submits Seedance 2.5 image-to-video", async () => {
  let call;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "seedance2_5",
    prepareInput: async (input, context) => {
      assert.equal(input.startFrameAssetId, "first-frame-asset");
      assert.equal(context.job.owner_id, "owner-1");
      return { firstFrame: { buffer: Buffer.alloc(512), filename: "frame.png", mimeType: "image/png" } };
    },
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith("/uploads")) return new Response(JSON.stringify({
        uploadUrl: "https://uploads.runway.example/signed-seedance",
        fields: { key: "seedance-first-frame" },
        runwayUri: "runway://ephemeral/seedance-first-frame"
      }), { status: 200 });
      if (target === "https://uploads.runway.example/signed-seedance") return new Response(null, { status: 204 });
      if (target.endsWith("/image_to_video")) {
        call = { url: target, options };
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      throw new Error("unexpected URL " + target);
    }
  });
  const input = {
    provider: "runway", model: "seedance2_5", operation: "image-to-video",
    prompt: "Animate the approved product frame", startFrameAssetId: "first-frame-asset",
    durationSeconds: 8, aspectRatio: "9:16", resolution: "720p"
  };
  const prepared = await adapter.prepareInput(input, { job: { owner_id: "owner-1" } });
  assert.deepEqual(prepared.promptImageKeyframes, [{ uri: "runway://ephemeral/seedance-first-frame", position: "first" }]);
  assert.deepEqual(await adapter.submit(prepared), { taskId: id, status: "queued" });
  assert.equal(call.url, "https://api.dev.runwayml.com/v1/image_to_video");
  assert.deepEqual(JSON.parse(call.options.body), {
    model: "seedance2_5", promptText: "Animate the approved product frame",
    promptImage: [{ uri: "runway://ephemeral/seedance-first-frame", position: "first" }],
    duration: 8, ratio: "720:1280"
  });
});

test("Seedance 2.5 image-to-video supports a 480p draft without exposing source paths", async () => {
  let body;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "seedance2_5",
    prepareInput: async () => ({ firstFrame: { buffer: Buffer.alloc(512), filename: "frame.png", mimeType: "image/png" } }),
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith("/uploads")) return new Response(JSON.stringify({
        uploadUrl: "https://uploads.runway.example/signed-draft-frame", fields: { key: "draft-frame" },
        runwayUri: "runway://ephemeral/draft-frame"
      }), { status: 200 });
      if (target === "https://uploads.runway.example/signed-draft-frame") return new Response(null, { status: 204 });
      if (target.endsWith("/image_to_video")) { body = JSON.parse(options.body); return new Response(JSON.stringify({ id }), { status: 200 }); }
      throw new Error("unexpected URL " + target);
    }
  });
  const prepared = await adapter.prepareInput({
    provider: "runway", model: "seedance2_5", operation: "image-to-video",
    prompt: "Animate the approved frame", startFrameAssetId: "approved-frame", durationSeconds: 6,
    aspectRatio: "16:9", resolution: "480p", draft: true
  }, { job: { owner_id: "owner-1" } });
  await adapter.submit(prepared);
  assert.deepEqual(body, {
    model: "seedance2_5", promptText: "Animate the approved frame", promptImage: [{ uri: "runway://ephemeral/draft-frame", position: "first" }],
    duration: 6, ratio: "854:480", draft: true
  });
});

test("Seedance 2.5 reference video-to-video draft is fixed at 480p", async () => {
  let body;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "seedance2_5",
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ id }), { status: 200 }); }
  });
  await adapter.submit({
    provider: "runway", model: "seedance2_5", operation: "video-to-video",
    prompt: "Continue the approved scene", videoUri: "runway://ephemeral/source", mode: "reference",
    durationSeconds: 6, aspectRatio: "16:9", resolution: "480p", draft: true
  });
  assert.deepEqual(body, {
    model: "seedance2_5", videoUri: "runway://ephemeral/source", promptText: "Continue the approved scene",
    mode: "reference", draft: true, duration: 6, ratio: "1280:720"
  });
});

test("Seedance 2.5 draft cannot be combined with video extend or edit modes", async () => {
  let calls = 0;
  const adapter = createRunwayCloudVideoAdapter({ ...base, model: "seedance2_5", fetchImpl: async () => { calls++; return new Response(JSON.stringify({ id }), { status: 200 }); } });
  await assert.rejects(() => adapter.submit({
    provider: "runway", model: "seedance2_5", operation: "video-to-video",
    prompt: "Continue the approved scene", videoUri: "runway://ephemeral/source", mode: "extend",
    duration: "auto", durationSeconds: 6, resolution: "480p", draft: true
  }), error => error.code === "RUNWAY_INPUT_INVALID");
  assert.equal(calls, 0);
});

test("Kling 4 text-to-video is accepted by the same exact-match durable adapter", async () => {
  let body;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "kling_4",
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
  });
  await adapter.submit({
    provider: "runway", model: "kling_4", operation: "text-to-video",
    prompt: "A cinematic tracking shot", durationSeconds: 8,
    aspectRatio: "16:9", resolution: "720p"
  });
  assert.deepEqual(body, {
    model: "kling_4", promptText: "A cinematic tracking shot",
    ratio: "1280:720", duration: 8
  });
});


test("Seedance 2.5 accepts its documented long-form prompt limit in durable execution", async () => {
  let submittedBody;
  const prompt = "A carefully directed cinematic sequence. ".repeat(250);
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "seedance2_5",
    fetchImpl: async (_url, options) => {
      submittedBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
  });
  await adapter.submit({
    provider: "runway", model: "seedance2_5", operation: "text-to-video",
    prompt, durationSeconds: 8, aspectRatio: "16:9", resolution: "720p"
  });
  assert.equal(submittedBody.promptText, prompt.trim());
});


test("passes explicit native-audio control only to Runway models that document an audio toggle", async () => {
  let body;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "kling3.0_pro",
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
  });
  await adapter.submit({
    provider: "runway", model: "kling3.0_pro", operation: "text-to-video",
    prompt: "A cinematic scene with clear ambient sound", durationSeconds: 8,
    aspectRatio: "16:9", audio: false
  });
  assert.equal(body.audio, false);
});


test("Seedance 2.5 reference video-to-video validates and uploads a private source", async () => {
  let submitted;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "seedance2_5",
    prepareInput: async input => {
      assert.equal(input.sourceVideoAssetId, "source-video");
      return {
        sourceVideo: { buffer: Buffer.alloc(512), filename: "source.mp4", mimeType: "video/mp4" },
        sourceMetadata: { durationSeconds: 8, width: 1920, height: 1080, frameRate: 30 }
      };
    },
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith("/uploads")) return new Response(JSON.stringify({
        uploadUrl: "https://uploads.runway.example/seedance-source",
        fields: { key: "seedance-source" }, runwayUri: "runway://ephemeral/seedance-source"
      }), { status: 200 });
      if (target === "https://uploads.runway.example/seedance-source") return new Response(null, { status: 204 });
      if (target.endsWith("/video_to_video")) {
        submitted = JSON.parse(options.body);
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      throw new Error("unexpected URL " + target);
    }
  });
  const input = {
    provider: "runway", model: "seedance2_5", operation: "video-to-video",
    sourceVideoAssetId: "source-video", prompt: "Continue the same cinematic scene",
    mode: "reference", durationSeconds: 8, aspectRatio: "16:9", resolution: "720p", audio: false
  };
  const prepared = await adapter.prepareInput(input, { job: { owner_id: "owner-1" } });
  assert.equal(prepared.videoUri, "runway://ephemeral/seedance-source");
  assert.equal(prepared.sourceMetadata.width, 1920);
  assert.deepEqual(await adapter.submit(prepared), { taskId: id, status: "queued" });
  assert.deepEqual(submitted, {
    model: "seedance2_5", videoUri: "runway://ephemeral/seedance-source",
    promptText: "Continue the same cinematic scene", mode: "reference",
    duration: 8, ratio: "1280:720", audio: false
  });
});

test("Gemini Omni 1.2 edit mode submits an owner-resolved source with automatic source-length output", async () => {
  let submitted;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "gemini_omni_flash_1.2",
    prepareInput: async input => {
      assert.equal(input.sourceVideoAssetId, "source-video");
      return {
        sourceVideo: { buffer: Buffer.alloc(512), filename: "source.mp4", mimeType: "video/mp4" },
        sourceMetadata: { durationSeconds: 8.4, width: 1920, height: 1080, frameRate: 30 }
      };
    },
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith("/uploads")) return new Response(JSON.stringify({
        uploadUrl: "https://uploads.runway.example/gemini-source",
        fields: { key: "gemini-source" }, runwayUri: "runway://ephemeral/gemini-source"
      }), { status: 200 });
      if (target === "https://uploads.runway.example/gemini-source") return new Response(null, { status: 204 });
      if (target.endsWith("/video_to_video")) {
        submitted = JSON.parse(options.body);
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      throw new Error("unexpected URL " + target);
    }
  });
  const input = {
    provider: "runway", model: "gemini_omni_flash_1.2", operation: "video-to-video",
    sourceVideoAssetId: "source-video", prompt: "Replace the background with a quiet coastal road",
    mode: "edit", duration: "auto", durationSeconds: 15, resolution: "720p"
  };
  const prepared = await adapter.prepareInput(input, { job: { owner_id: "owner-1" } });
  assert.equal(prepared.videoUri, "runway://ephemeral/gemini-source");
  assert.equal(prepared.sourceMetadata.durationSeconds, 8.4);
  assert.deepEqual(await adapter.submit(prepared), { taskId: id, status: "queued" });
  assert.deepEqual(submitted, {
    model: "gemini_omni_flash_1.2", videoUri: "runway://ephemeral/gemini-source",
    promptText: "Replace the background with a quiet coastal road", mode: "edit", duration: "auto", resolution: "720p"
  });
});

test("Gemini Omni 1.2 reference mode maps resolution and ratio; extend omits ratio", async () => {
  const bodies = [];
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "gemini_omni_flash_1.2",
    prepareInput: async input => ({
      sourceVideo: { buffer: Buffer.alloc(512), filename: "source.mp4", mimeType: "video/mp4" },
      sourceMetadata: { durationSeconds: input.mode === "extend" ? 25 : 8, width: 1920, height: 1080, frameRate: 30 }
    }),
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith("/uploads")) return new Response(JSON.stringify({
        uploadUrl: "https://uploads.runway.example/gemini-ref",
        fields: { key: "gemini-ref" }, runwayUri: "runway://ephemeral/gemini-ref"
      }), { status: 200 });
      if (target === "https://uploads.runway.example/gemini-ref") return new Response(null, { status: 204 });
      if (target.endsWith("/video_to_video")) {
        bodies.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      throw new Error("unexpected URL " + target);
    }
  });
  const reference = await adapter.prepareInput({
    provider: "runway", model: "gemini_omni_flash_1.2", operation: "video-to-video",
    sourceVideoAssetId: "source-video", prompt: "Use this clip as a visual reference",
    mode: "reference", durationSeconds: 5, aspectRatio: "16:9", resolution: "1080p"
  }, { job: { owner_id: "owner-1" } });
  await adapter.submit(reference);
  const extend = await adapter.prepareInput({
    provider: "runway", model: "gemini_omni_flash_1.2", operation: "video-to-video",
    sourceVideoAssetId: "source-video", prompt: "Continue the scene",
    mode: "extend", duration: 5, durationSeconds: 5, resolution: "1080p"
  }, { job: { owner_id: "owner-1" } });
  await adapter.submit(extend);
  assert.deepEqual(bodies[0], {
    model: "gemini_omni_flash_1.2", videoUri: "runway://ephemeral/gemini-ref",
    promptText: "Use this clip as a visual reference", mode: "reference", duration: 5, ratio: "1920:1080"
  });
  assert.deepEqual(bodies[1], {
    model: "gemini_omni_flash_1.2", videoUri: "runway://ephemeral/gemini-ref",
    promptText: "Continue the scene", mode: "extend", duration: 5, resolution: "1080p"
  });
});

test("Gemini Omni 1.2 accepts an authorized first frame through the durable image-to-video path", async () => {
  let submitted;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "gemini_omni_flash_1.2",
    prepareInput: async () => ({
      firstFrame: { buffer: Buffer.alloc(512), filename: "first.png", mimeType: "image/png" }
    }),
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith("/uploads")) return new Response(JSON.stringify({
        uploadUrl: "https://uploads.runway.example/gemini-first-frame",
        fields: { key: "gemini-first-frame" }, runwayUri: "runway://ephemeral/gemini-first-frame"
      }), { status: 200 });
      if (target === "https://uploads.runway.example/gemini-first-frame") return new Response(null, { status: 204 });
      if (target.endsWith("/image_to_video")) {
        submitted = JSON.parse(options.body);
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      throw new Error("unexpected URL " + target);
    }
  });
  const input = {
    provider: "runway", model: "gemini_omni_flash_1.2", operation: "image-to-video",
    prompt: "Animate the approved opening frame", startFrameAssetId: "first-frame-asset",
    durationSeconds: 5, aspectRatio: "9:16", resolution: "1080p"
  };
  const prepared = await adapter.prepareInput(input, { job: { owner_id: "owner-1" } });
  assert.equal(prepared.promptImageUri, "runway://ephemeral/gemini-first-frame");
  assert.deepEqual(await adapter.submit(prepared), { taskId: id, status: "queued" });
  assert.deepEqual(submitted, {
    model: "gemini_omni_flash_1.2", promptText: "Animate the approved opening frame",
    promptImage: "runway://ephemeral/gemini-first-frame", ratio: "1080:1920", duration: 5
  });
});

test("Gemini Omni 1.2 enforces distinct reference, edit and extension source limits", async () => {
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "gemini_omni_flash_1.2",
    prepareInput: async input => ({
      videoUri: "runway://ephemeral/source",
      sourceMetadata: { durationSeconds: input.testDuration, width: 1920, height: 1080, frameRate: 30 }
    }),
    fetchImpl: async () => { throw new Error("provider submission must not run during source validation"); }
  });
  for (const [mode, seconds] of [["reference", 10.01], ["edit", 10], ["extend", 30.01]]) {
    await assert.rejects(() => adapter.prepareInput({
      provider: "runway", model: "gemini_omni_flash_1.2", operation: "video-to-video",
      sourceVideoAssetId: "source-video", prompt: "Apply a cinematic visual transformation",
      mode, duration: mode === "edit" ? "auto" : 5, testDuration: seconds
    }, { job: { owner_id: "owner-1" } }), error => error.code === "RUNWAY_INPUT_INVALID");
  }
});

test("Kling 4 video-to-video rejects source metadata outside the provider contract before submission", async () => {
  let generationCalls = 0;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "kling_4",
    prepareInput: async () => ({
      sourceVideo: { buffer: Buffer.alloc(512), filename: "source.mp4", mimeType: "video/mp4" },
      sourceMetadata: { durationSeconds: 8, width: 640, height: 360, frameRate: 30 }
    }),
    fetchImpl: async (url) => {
      const target = String(url);
      if (target.endsWith("/uploads")) return new Response(JSON.stringify({
        uploadUrl: "https://uploads.runway.example/invalid-kling-source", fields: { key: "invalid" },
        runwayUri: "runway://ephemeral/invalid-kling-source"
      }), { status: 200 });
      if (target === "https://uploads.runway.example/invalid-kling-source") return new Response(null, { status: 204 });
      if (target.endsWith("/video_to_video")) generationCalls += 1;
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
  });
  await assert.rejects(
    () => adapter.prepareInput({
      provider: "runway", model: "kling_4", operation: "video-to-video",
      sourceVideoAssetId: "source-video", prompt: "Edit this clip"
    }, { job: { owner_id: "owner-1" } }),
    error => error.code === "RUNWAY_INPUT_INVALID"
  );
  assert.equal(generationCalls, 0);
});


test("Kling 4 video-to-video submits a private source after validating source metadata", async () => {
  let body;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "kling_4",
    prepareInput: async () => ({
      sourceVideo: { buffer: Buffer.alloc(512), filename: "source.mp4", mimeType: "video/mp4" },
      sourceMetadata: { durationSeconds: 10, width: 1920, height: 1080, frameRate: 30 }
    }),
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith("/uploads")) return new Response(JSON.stringify({
        uploadUrl: "https://uploads.runway.example/kling-source",
        fields: { key: "kling-source" }, runwayUri: "runway://ephemeral/kling-source"
      }), { status: 200 });
      if (target === "https://uploads.runway.example/kling-source") return new Response(null, { status: 204 });
      if (target.endsWith("/video_to_video")) {
        body = JSON.parse(options.body);
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      throw new Error("unexpected URL " + target);
    }
  });
  const input = {
    provider: "runway", model: "kling_4", operation: "video-to-video",
    sourceVideoAssetId: "source-video", prompt: "Replace the background with a studio"
  };
  const prepared = await adapter.prepareInput(input, { job: { owner_id: "owner-1" } });
  assert.equal(prepared.videoUri, "runway://ephemeral/kling-source");
  assert.deepEqual(await adapter.submit(prepared), { taskId: id, status: "queued" });
  assert.deepEqual(body, {
    model: "kling_4", videoUri: "runway://ephemeral/kling-source",
    promptText: "Replace the background with a studio"
  });
});

test("Kling 3.0 durable worker submits a multi-shot task without a top-level prompt",async()=>{
 let submitted;
 const adapter=createRunwayCloudVideoAdapter({
  ...base,model:"kling3.0_pro",
  fetchImpl:async(url,options={})=>{
   if(String(url).endsWith("/text_to_video")){submitted=JSON.parse(options.body);return new Response(JSON.stringify({id}),{status:200});}
   throw new Error("unexpected URL "+String(url));
  }
 });
 const multiPrompt=[{prompt:"A wide establishing shot of a forest",duration:5},{prompt:"A close-up of a bird taking flight",duration:5}];
 const result=await adapter.submit({provider:"runway",model:"kling3.0_pro",operation:"text-to-video",prompt:"",multiPrompt,aspectRatio:"16:9"});
 assert.deepEqual(result,{taskId:id,status:"queued"});
 assert.deepEqual(submitted,{model:"kling3.0_pro",ratio:"1920:1080",providerSettings:{multiPrompt,shotType:"customize"}});
});

for (const mode of ["extend","edit"]) {
 test("Seedance 2.5 "+mode+" video edit submits the documented source mode payload",async()=>{
  let submitted;
  const adapter=createRunwayCloudVideoAdapter({
   ...base,model:"seedance2_5",
   fetchImpl:async(url,options={})=>{
    if(String(url).endsWith("/video_to_video")){submitted=JSON.parse(options.body);return new Response(JSON.stringify({id}),{status:200});}
    throw new Error("unexpected URL "+String(url));
   }
  });
  const result=await adapter.submit({
   provider:"runway",model:"seedance2_5",operation:"video-to-video",
   videoUri:"runway://ephemeral/seedance-source",prompt:"Make the scene more cinematic",
   mode,duration:"auto"
  });
  assert.deepEqual(result,{taskId:id,status:"queued"});
  assert.deepEqual(submitted,{
   model:"seedance2_5",videoUri:"runway://ephemeral/seedance-source",
   promptText:"Make the scene more cinematic",mode,duration:"auto"
  });
 });
}

test("Veo 3.1 submits text-to-video with strict frame, audio and cost preflight controls", async () => {
  let call;
  let billingReadinessCalls = 0;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "veo3.1",
    assertActualCostReady: async () => { billingReadinessCalls += 1; return true; },
    fetchImpl: async (url, options) => {
      call = { url: String(url), options };
      return new Response(JSON.stringify({ id }));
    }
  });
  assert.equal(typeof adapter.preflight, "function");
  const quote = await adapter.preflight({ provider: "runway", model: "veo3.1", prompt: "A lighthouse at dusk", durationSeconds: 4, audio: true });
  assert.equal(billingReadinessCalls, 0, "non-billable estimates must not call provider billing endpoints");
  assert.deepEqual({
    billable: quote.billable, provider: quote.provider, model: quote.model,
    estimatedCredits: quote.estimatedCredits, estimatedUsd: quote.estimatedUsd, currency: quote.currency
  }, {
    billable: false, provider: "runway", model: "veo3.1",
    estimatedCredits: 160, estimatedUsd: 1.6, currency: "USD"
  });
  const submitted = await adapter.submit({
    provider: "runway", model: "veo3.1", prompt: "A lighthouse at dusk",
    durationSeconds: 4, aspectRatio: "16:9", resolution: "720p",
    audio: true, negativePrompt: "text overlays", seed: 42
  });
  assert.equal(submitted.taskId, id);
  assert.equal(submitted.status, "queued");
  assert.ok(Number.isFinite(Date.parse(submitted.metadata.submittedAt)));
  assert.equal(billingReadinessCalls, 1, "linked-workspace billing access must be checked before paid submission");
  assert.equal(call.url, "https://api.dev.runwayml.com/v1/text_to_video");
  assert.deepEqual(JSON.parse(call.options.body), {
    model: "veo3.1", promptText: "A lighthouse at dusk", ratio: "1280:720",
    duration: 4, audio: true, negativePrompt: "text overlays", seed: 42
  });
});

test("Veo 3.1 Fast interpolates authorized first and last frames", async () => {
  let call;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "veo3.1_fast",
    fetchImpl: async (url, options) => {
      call = { url: String(url), options };
      return new Response(JSON.stringify({ id }));
    }
  });
  const input = {
    provider: "runway", model: "veo3.1_fast", operation: "image-to-video",
    prompt: "Transition smoothly from sunrise to sunset",
    promptImage: [
      { uri: "runway://ephemeral/first-frame", position: "first" },
      { uri: "runway://ephemeral/last-frame", position: "last" }
    ],
    durationSeconds: 8, aspectRatio: "9:16", resolution: "1080p", audio: false
  };
  const quote = await adapter.preflight(input);
  assert.equal(quote.estimatedCredits, 80);
  assert.equal(quote.estimatedUsd, 0.8);
  await adapter.submit(input);
  assert.equal(call.url, "https://api.dev.runwayml.com/v1/image_to_video");
  assert.deepEqual(JSON.parse(call.options.body), {
    model: "veo3.1_fast", promptText: input.prompt,
    promptImage: input.promptImage, ratio: "1080:1920", duration: 8, audio: false
  });
});

test("Veo private first/last frame assets are uploaded before task submission", async () => {
  const calls = [];
  let upload = 0;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "veo3.1",
    prepareInput: async (input, context) => {
      assert.equal(context.job.owner_id, "owner-1");
      return {
        firstFrame: { buffer: Buffer.alloc(512), filename: "first.png", mimeType: "image/png" },
        lastFrame: { buffer: Buffer.alloc(512), filename: "last.png", mimeType: "image/png" }
      };
    },
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      calls.push({ target, options });
      if (target.endsWith("/uploads")) {
        upload += 1;
        return new Response(JSON.stringify({
          uploadUrl: "https://uploads.runway.example/signed-" + upload,
          fields: { key: "frame-" + upload },
          runwayUri: "runway://ephemeral/frame-" + upload
        }));
      }
      if (target.startsWith("https://uploads.runway.example/")) return new Response(null, { status: 204 });
      if (target.endsWith("/image_to_video")) return new Response(JSON.stringify({ id }));
      throw new Error("Unexpected URL " + target);
    }
  });
  const prepared = await adapter.prepareInput({
    provider: "runway", model: "veo3.1", operation: "image-to-video",
    startFrameAssetId: "private-first", endFrameAssetId: "private-last",
    prompt: "Animate between the two approved frames"
  }, { job: { owner_id: "owner-1" } });
  assert.deepEqual(prepared.promptImage, [
    { uri: "runway://ephemeral/frame-1", position: "first" },
    { uri: "runway://ephemeral/frame-2", position: "last" }
  ]);
  await adapter.submit({ ...prepared, durationSeconds: 8, aspectRatio: "16:9" });
  const task = calls.find(call => call.target.endsWith("/image_to_video"));
  assert.ok(task);
  assert.equal(calls.filter(call => call.target.endsWith("/uploads")).length, 2);
});

test("Veo rejects invalid frame pairs, unsupported durations and 1080p short clips before POST", async () => {
  let calls = 0;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "veo3.1",
    fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ id })); }
  });
  const frame = { uri: "runway://ephemeral/frame", position: "last" };
  const common = { provider: "runway", model: "veo3.1", prompt: "A moving scene", durationSeconds: 8 };
  await assert.rejects(() => adapter.submit({ ...common, promptImage: [frame] }), error => error.code === "RUNWAY_INPUT_INVALID");
  await assert.rejects(() => adapter.submit({ ...common, durationSeconds: 5 }), error => error.code === "RUNWAY_INPUT_INVALID");
  await assert.rejects(() => adapter.submit({ ...common, durationSeconds: 4, resolution: "1080p" }), error => error.code === "RUNWAY_INPUT_INVALID");
  await assert.rejects(() => adapter.submit({ ...common, durationSeconds: 8, seed: 4294967296 }), error => error.code === "RUNWAY_INPUT_INVALID");
  await assert.rejects(() => adapter.submit({ ...common, durationSeconds: 8, aspectRatio: "1:1" }), error => error.code === "RUNWAY_INPUT_INVALID");
  assert.equal(calls, 0);
});

test("Veo submission refuses paid execution when linked-workspace billing is unavailable", async () => {
  let providerCalls = 0;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "veo3.1",
    assertActualCostReady: async () => { throw Object.assign(new Error("Workspace account link missing"), { code: "RUNWAY_TASK_BILLING_LINK_REQUIRED" }); },
    fetchImpl: async () => { providerCalls += 1; return new Response(JSON.stringify({ id })); }
  });
  await assert.rejects(
    () => adapter.submit({ provider: "runway", model: "veo3.1", prompt: "A quiet mountain lake", durationSeconds: 4 }),
    error => error.code === "RUNWAY_TASK_BILLING_LINK_REQUIRED"
  );
  assert.equal(providerCalls, 0);
});

test("Veo preflight rejects invalid requests before the worker can begin a provider submission", async () => {
  const adapter = createRunwayCloudVideoAdapter({ ...base, model: "veo3.1" });
  await assert.rejects(() => adapter.preflight({
    provider: "runway", model: "veo3.1", prompt: "Bad duration", durationSeconds: 5
  }), error => error.code === "RUNWAY_INPUT_INVALID");
  await assert.rejects(() => adapter.preflight({
    provider: "runway", model: "veo3.1", prompt: "Bad resolution", durationSeconds: 4,
    resolution: "1080p"
  }), error => error.code === "RUNWAY_INPUT_INVALID");
  await assert.rejects(() => adapter.preflight({
    provider: "runway", model: "veo3.1", operation: "image-to-video",
    promptImage: [{ uri: "runway://ephemeral/last", position: "last" }], durationSeconds: 8
  }), error => error.code === "RUNWAY_INPUT_INVALID");
});

test("Veo preflight rates are model-specific and do not alter other Runway adapters", async () => {
  const standard = createRunwayCloudVideoAdapter({ ...base, model: "veo3.1" });
  const fast = createRunwayCloudVideoAdapter({ ...base, model: "veo3.1_fast" });
  const gen = createRunwayCloudVideoAdapter({ ...base, model: "gen4.5" });
  assert.equal((await standard.preflight({ provider: "runway", model: "veo3.1", prompt: "A quiet lake", durationSeconds: 6, audio: false })).estimatedUsd, 1.2);
  assert.equal((await fast.preflight({ provider: "runway", model: "veo3.1_fast", prompt: "A quiet lake", durationSeconds: 6, audio: true })).estimatedUsd, 0.9);
  assert.equal(typeof gen.preflight, "undefined");
});

test("uploads private Seedance image and audio references and supports reference-only generation", async () => {
  let submittedBody;
  const uploads = [];
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "seedance2_5",
    prepareInput: async () => ({
      referenceImages: [{ buffer: Buffer.alloc(512), filename: "character.png", mimeType: "image/png" }],
      referenceAudio: [{ buffer: Buffer.alloc(512), filename: "ambience.wav", mimeType: "audio/wav" }]
    }),
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith("/uploads")) {
        const index = uploads.length + 1;
        uploads.push(JSON.parse(options.body));
        return new Response(JSON.stringify({
          uploadUrl: "https://uploads.runway.example/seedance-reference-" + index,
          fields: { key: "reference-" + index },
          runwayUri: "runway://ephemeral/seedance-reference-" + index
        }), { status: 200 });
      }
      if (target.startsWith("https://uploads.runway.example/")) return new Response(null, { status: 204 });
      if (target.endsWith("/text_to_video")) {
        submittedBody = JSON.parse(options.body);
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      throw new Error("unexpected URL " + target);
    }
  });
  const prepared = await adapter.prepareInput({
    provider: "runway", model: "seedance2_5", operation: "text-to-video",
    durationSeconds: 8, aspectRatio: "16:9", resolution: "720p"
  }, { job: { owner_id: "owner-1" } });
  assert.deepEqual(prepared.references, [{ uri: "runway://ephemeral/seedance-reference-1" }]);
  assert.deepEqual(prepared.referenceAudio, [{ uri: "runway://ephemeral/seedance-reference-2" }]);
  const submitted = await adapter.submit(prepared);
  assert.equal(submitted.taskId, id);
  assert.equal(uploads.length, 2);
  assert.deepEqual(submittedBody, {
    model: "seedance2_5", ratio: "1280:720", duration: 8,
    references: [{ uri: "runway://ephemeral/seedance-reference-1" }],
    referenceAudio: [{ uri: "runway://ephemeral/seedance-reference-2" }]
  });
});


test("uploads Seedance image-to-video references without keyframe positions and submits reference audio", async () => {
  let submittedBody;
  const uploads = [];
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "seedance2_5",
    prepareInput: async () => ({
      imageReferenceMode: true,
      referenceImages: [{ buffer: Buffer.alloc(512), filename: "subject.png", mimeType: "image/png" }],
      referenceAudio: [{ buffer: Buffer.alloc(512), filename: "ambience.wav", mimeType: "audio/wav" }]
    }),
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith("/uploads")) {
        const index = uploads.length + 1;
        uploads.push(JSON.parse(options.body));
        return new Response(JSON.stringify({
          uploadUrl: "https://uploads.runway.example/seedance-i2v-" + index,
          fields: { key: "reference-" + index },
          runwayUri: "runway://ephemeral/seedance-i2v-" + index
        }), { status: 200 });
      }
      if (target.startsWith("https://uploads.runway.example/")) return new Response(null, { status: 204 });
      if (target.endsWith("/image_to_video")) {
        submittedBody = JSON.parse(options.body);
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      throw new Error("unexpected URL " + target);
    }
  });
  const prepared = await adapter.prepareInput({
    provider: "runway", model: "seedance2_5", operation: "image-to-video",
    prompt: "Animate the subject to the supplied ambience",
    durationSeconds: 8, aspectRatio: "16:9", resolution: "720p"
  }, { job: { owner_id: "owner-1" } });
  assert.deepEqual(prepared.promptImageReferences, [{ uri: "runway://ephemeral/seedance-i2v-1" }]);
  assert.deepEqual(prepared.referenceAudio, [{ uri: "runway://ephemeral/seedance-i2v-2" }]);
  const submitted = await adapter.submit(prepared);
  assert.equal(submitted.taskId, id);
  assert.equal(uploads.length, 2);
  assert.equal(submittedBody.model, "seedance2_5");
  assert.deepEqual(submittedBody.promptImage, [{ uri: "runway://ephemeral/seedance-i2v-1" }]);
  assert.deepEqual(submittedBody.referenceAudio, [{ uri: "runway://ephemeral/seedance-i2v-2" }]);
  assert.equal(submittedBody.promptText, "Animate the subject to the supplied ambience");
});


test("uploads private Seedance video references to ephemeral storage and submits the native referenceVideos field", async () => {
  let submittedBody;
  const uploads = [];
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "seedance2_5",
    prepareInput: async () => ({
      referenceVideos: [{ buffer: Buffer.alloc(512), filename: "motion.mp4", mimeType: "video/mp4", durationSeconds: 6 }]
    }),
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith("/uploads")) {
        const index = uploads.length + 1;
        uploads.push(JSON.parse(options.body));
        return new Response(JSON.stringify({
          uploadUrl: "https://uploads.runway.example/seedance-video-reference-" + index,
          fields: { key: "reference-video-" + index },
          runwayUri: "runway://ephemeral/seedance-video-reference-" + index
        }), { status: 200 });
      }
      if (target.startsWith("https://uploads.runway.example/")) return new Response(null, { status: 204 });
      if (target.endsWith("/text_to_video")) {
        submittedBody = JSON.parse(options.body);
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      throw new Error("unexpected URL " + target);
    }
  });
  const prepared = await adapter.prepareInput({
    provider: "runway", model: "seedance2_5", operation: "text-to-video",
    prompt: "Use the supplied motion reference", durationSeconds: 8,
    aspectRatio: "16:9", resolution: "720p", referenceVideoAssetIds: ["private-video-id"]
  }, { job: { owner_id: "owner-1" } });
  assert.deepEqual(prepared.referenceVideos, [{ uri: "runway://ephemeral/seedance-video-reference-1" }]);
  const submitted = await adapter.submit(prepared);
  assert.equal(submitted.taskId, id);
  assert.equal(uploads.length, 1);
  assert.deepEqual(submittedBody.referenceVideos, [{ uri: "runway://ephemeral/seedance-video-reference-1" }]);
  assert.equal(submittedBody.promptText, "Use the supplied motion reference");
});


test("uploads and submits Seedance first and last keyframes as distinct positioned references", async () => {
  let submittedBody;
  let uploadCount = 0;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "seedance2_5",
    prepareInput: async () => ({
      firstFrame: { buffer: Buffer.alloc(512), filename: "first.png", mimeType: "image/png" },
      lastFrame: { buffer: Buffer.alloc(512), filename: "last.png", mimeType: "image/png" }
    }),
    fetchImpl: async (url, options = {}) => {
      const target = String(url);
      if (target.endsWith("/uploads")) {
        uploadCount++;
        return new Response(JSON.stringify({
          uploadUrl: "https://uploads.runway.example/seedance-keyframe-" + uploadCount,
          fields: { key: "keyframe-" + uploadCount },
          runwayUri: "runway://ephemeral/seedance-keyframe-" + uploadCount
        }), { status: 200 });
      }
      if (target.startsWith("https://uploads.runway.example/")) return new Response(null, { status: 204 });
      if (target.endsWith("/image_to_video")) {
        submittedBody = JSON.parse(options.body);
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      throw new Error("unexpected URL " + target);
    }
  });
  const prepared = await adapter.prepareInput({
    provider: "runway", model: "seedance2_5", operation: "image-to-video",
    prompt: "Move between the first and last frames", durationSeconds: 8,
    aspectRatio: "16:9", resolution: "720p", startFrameAssetId: "first-id", endFrameAssetId: "last-id"
  }, { job: { owner_id: "owner-1" } });
  assert.deepEqual(prepared.promptImageKeyframes, [
    { uri: "runway://ephemeral/seedance-keyframe-1", position: "first" },
    { uri: "runway://ephemeral/seedance-keyframe-2", position: "last" }
  ]);
  const submitted = await adapter.submit(prepared);
  assert.equal(submitted.taskId, id);
  assert.equal(uploadCount, 2);
  assert.deepEqual(submittedBody.promptImage, prepared.promptImageKeyframes);
});


test("quarantines ambiguous Runway submission responses instead of risking a duplicate paid task", async () => {
  const input = {
    provider: "runway", model: "gen4.5", prompt: "A cinematic sunrise",
    durationSeconds: 5, aspectRatio: "16:9"
  };
  for (const response of [
    new Response("upstream error", { status: 520 }),
    new Response("{not-json", { status: 200 }),
    new Response("{}", { status: 200 })
  ]) {
    const adapter = createRunwayCloudVideoAdapter({
      ...base,
      fetchImpl: async () => response
    });
    await assert.rejects(
      () => adapter.submit(input),
      error => error.code === "RUNWAY_SUBMISSION_UNKNOWN"
    );
  }
});

test("preserves documented retryable Runway load-shedding responses", async () => {
  const input = {
    provider: "runway", model: "gen4.5", prompt: "A cinematic sunrise",
    durationSeconds: 5, aspectRatio: "16:9"
  };
  for (const status of [502, 503, 504]) {
    const adapter = createRunwayCloudVideoAdapter({
      ...base,
      fetchImpl: async () => new Response("temporary", { status })
    });
    await assert.rejects(
      () => adapter.submit(input),
      error => error.code === "RUNWAY_SERVER_ERROR" && error.retryable === true && error.retryAfterSeconds === 30
    );
  }
});

test("quarantines undocumented Runway server responses during task creation", async () => {
  const input = {
    provider: "runway", model: "gen4.5", prompt: "A cinematic sunrise",
    durationSeconds: 5, aspectRatio: "16:9"
  };
  const adapter = createRunwayCloudVideoAdapter({
    ...base,
    fetchImpl: async () => new Response("unknown upstream failure", { status: 520 })
  });
  await assert.rejects(
    () => adapter.submit(input),
    error => error.code === "RUNWAY_SUBMISSION_UNKNOWN"
  );
});

test("quarantines undocumented HTTP 500 task-creation responses", async () => {
  const input = {
    provider: "runway", model: "gen4.5", prompt: "A cinematic sunrise",
    durationSeconds: 5, aspectRatio: "16:9"
  };
  const adapter = createRunwayCloudVideoAdapter({
    ...base,
    fetchImpl: async () => new Response("internal error", { status: 500 })
  });
  await assert.rejects(
    () => adapter.submit(input),
    error => error.code === "RUNWAY_SUBMISSION_UNKNOWN"
  );
});

test("marks documented Runway 429 rate limits as explicitly retryable", async () => {
  const input = {
    provider: "runway", model: "gen4.5", prompt: "A cinematic sunrise",
    durationSeconds: 5, aspectRatio: "16:9"
  };
  const adapter = createRunwayCloudVideoAdapter({
    ...base,
    fetchImpl: async () => new Response("rate limited", { status: 429 })
  });
  await assert.rejects(
    () => adapter.submit(input),
    error => error.code === "RUNWAY_RATE_LIMITED" && error.retryable === true && error.retryAfterSeconds === 60
  );
});
