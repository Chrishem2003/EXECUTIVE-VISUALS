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
  await assert.rejects(() => adapter.submit({ provider: "runway", model: "gen4.5", prompt: "test", durationSeconds: 8 }), error => error.code === "RUNWAY_INPUT_INVALID");
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
  const quote = await adapter.preflight({ durationSeconds: 4, audio: true });
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

test("Veo preflight refuses paid submission when linked Enterprise billing is unavailable", async () => {
  let providerCalls = 0;
  const adapter = createRunwayCloudVideoAdapter({
    ...base, model: "veo3.1",
    assertActualCostReady: async () => { throw Object.assign(new Error("Enterprise link missing"), { code: "RUNWAY_TASK_BILLING_ENTERPRISE_REQUIRED" }); },
    fetchImpl: async () => { providerCalls += 1; return new Response(JSON.stringify({ id })); }
  });
  await assert.rejects(
    () => adapter.preflight({ provider: "runway", model: "veo3.1", prompt: "A quiet mountain lake", durationSeconds: 4 }),
    error => error.code === "RUNWAY_TASK_BILLING_ENTERPRISE_REQUIRED"
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
  assert.equal((await standard.preflight({ durationSeconds: 6, audio: false })).estimatedUsd, 1.2);
  assert.equal((await fast.preflight({ durationSeconds: 6, audio: true })).estimatedUsd, 0.9);
  assert.equal(typeof gen.preflight, "undefined");
});
