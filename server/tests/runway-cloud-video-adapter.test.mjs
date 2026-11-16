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
  resolveActualCost: async () => ({ amount: 12, currency: "USD", evidenceReference: "runway:usage-row:1" })
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
    ratio: "854:480", duration: 8, draft: true
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
  assert.equal(prepared.promptImageUri, "runway://ephemeral/seedance-first-frame");
  assert.deepEqual(await adapter.submit(prepared), { taskId: id, status: "queued" });
  assert.equal(call.url, "https://api.dev.runwayml.com/v1/image_to_video");
  assert.deepEqual(JSON.parse(call.options.body), {
    model: "seedance2_5", promptText: "Animate the approved product frame",
    promptImage: "runway://ephemeral/seedance-first-frame",
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
    model: "seedance2_5", promptText: "Animate the approved frame", promptImage: "runway://ephemeral/draft-frame",
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
    mode: "reference", draft: true, duration: 6, ratio: "854:480"
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
