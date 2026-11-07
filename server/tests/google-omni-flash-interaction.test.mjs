import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGeminiOmniFlashInteractionRequest,
  normalizeGeminiOmniFlashInteractionResponse
} from "../google-omni-flash-interaction.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const imageId = "33333333-3333-4333-8333-333333333333";
const firstId = "44444444-4444-4444-8444-444444444444";
const lastId = "55555555-5555-4555-8555-555555555555";
const videoId = "66666666-6666-4666-8666-666666666666";
const refVideoId = "77777777-7777-4777-8777-777777777777";
const googleUri = id => "https://generativelanguage.googleapis.com/v1beta/files/" + id;

function assetHarness(overrides = {}) {
  const calls = [];
  return {
    calls,
    getAuthorizedAssetContext: async args => ({ ownerId, projectId: args.projectId }),
    resolveGoogleFileAsset: async args => {
      calls.push(args);
      const durationSeconds = args.assetId === refVideoId ? 2.5 : args.assetId === videoId ? 8 : undefined;
      return {
        uri: googleUri(args.assetId),
        mediaType: args.mediaType,
        ...(durationSeconds === undefined ? {} : { durationSeconds }),
        ...overrides[args.assetId]
      };
    }
  };
}

test("builds a URI-delivery text-to-video request with the documented model and defaults", async () => {
  const result = await buildGeminiOmniFlashInteractionRequest({
    prompt: "A cinematic product reveal at sunrise"
  });
  assert.equal(result.endpoint, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(result.method, "POST");
  assert.deepEqual(result.auth, { headerName: "x-goog-api-key", credentialSource: "server-only" });
  assert.equal(Object.hasOwn(result, "headers"), false);
  assert.equal(result.payload.model, "gemini-omni-1.1-flash");
  assert.equal(result.payload.input, "A cinematic product reveal at sunrise");
  assert.deepEqual(result.payload.response_format, {
    type: "video", aspect_ratio: "16:9", resolution: "720p", delivery: "uri"
  });
  assert.equal(result.policy.remoteExecution, false);
  assert.equal(result.policy.requiresApproval, true);
  assert.equal(result.policy.outputMustBeIngestedPrivately, true);
});

test("builds portrait 4K requests and preserves stateful interaction lineage", async () => {
  const result = await buildGeminiOmniFlashInteractionRequest({
    prompt: "Keep everything else the same. Change the lighting to dusk.",
    operation: "edit",
    previousInteractionId: "v1_abcdef123456",
    projectId,
    getAuthorizedAssetContext: async args => ({ ownerId, projectId: args.projectId }),
    getAuthorizedInteractionContext: async args => ({ ownerId: args.ownerId, projectId: args.projectId, model: "gemini-omni-1.1-flash" }),
    aspectRatio: "9:16",
    resolution: "4k",
    delivery: "uri"
  });
  assert.equal(result.payload.previous_interaction_id, "v1_abcdef123456");
  assert.deepEqual(result.payload.response_format, {
    type: "video", aspect_ratio: "9:16", resolution: "4k", delivery: "uri"
  });
});

test("stateful edit lineage must belong to the authenticated owner, project and model", async () => {
  const base = {
    prompt: "Keep everything else the same. Change the lighting.",
    operation: "edit",
    previousInteractionId: "v1_abcdef123456",
    projectId,
    getAuthorizedAssetContext: async args => ({ ownerId, projectId: args.projectId })
  };
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest(base),
    error => error.code === "GEMINI_OMNI_INTERACTION_GATES_MISSING");
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({
    ...base,
    getAuthorizedInteractionContext: async () => { throw new Error("not found"); }
  }), error => error.code === "GEMINI_OMNI_INTERACTION_FORBIDDEN");
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({
    ...base,
    getAuthorizedInteractionContext: async () => ({
      ownerId, projectId: "33333333-3333-4333-8333-333333333333", model: "gemini-omni-1.1-flash"
    })
  }), error => error.code === "GEMINI_OMNI_INTERACTION_FORBIDDEN");
  const accepted = await buildGeminiOmniFlashInteractionRequest({
    ...base,
    getAuthorizedInteractionContext: async args => ({
      ownerId: args.ownerId, projectId: args.projectId, model: "gemini-omni-1.1-flash"
    })
  });
  assert.equal(accepted.payload.previous_interaction_id, "v1_abcdef123456");
});

test("resolves image and video references only through authenticated project scope", async () => {
  const harness = assetHarness();
  const result = await buildGeminiOmniFlashInteractionRequest({
    prompt: "A person walks into the scene",
    projectId,
    referenceImageAssetIds: [imageId],
    sourceVideoAssetId: videoId,
    operation: "edit",
    getAuthorizedAssetContext: harness.getAuthorizedAssetContext,
    resolveGoogleFileAsset: harness.resolveGoogleFileAsset
  });
  assert.deepEqual(result.payload.input, [
    { type: "video", uri: googleUri(videoId) },
    { type: "image", uri: googleUri(imageId) },
    { type: "text", text: "A person walks into the scene" }
  ]);
  assert.deepEqual(result.payload.generation_config, { video_config: { task: "edit" } });
  assert.equal(harness.calls.length, 2);
  assert.ok(harness.calls.every(call => call.ownerId === ownerId && call.projectId === projectId));
});

test("accepts private signed URLs for small media and rejects expired or oversized signed URLs", async () => {
  const signedUri = "https://private-project.supabase.co/storage/v1/object/sign/executive-visuals-media/" +
    projectId + "/" + imageId + "/reference.png?token=private-token";
  const resolver = async args => ({
    uri: signedUri,
    mediaType: args.mediaType,
    sourceType: "signed_url",
    sizeBytes: 1024,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  });
  const result = await buildGeminiOmniFlashInteractionRequest({
    prompt: "Animate this private image",
    projectId, firstFrameAssetId: imageId,
    getAuthorizedAssetContext: async args => ({ ownerId, projectId: args.projectId }),
    resolveGoogleFileAsset: resolver
  });
  assert.deepEqual(result.payload.input, [
    { type: "image", uri: signedUri },
    { type: "text", text: "Animate this private image" }
  ]);

  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({
    prompt: "Animate this private image",
    projectId, firstFrameAssetId: imageId,
    getAuthorizedAssetContext: async args => ({ ownerId, projectId: args.projectId }),
    resolveGoogleFileAsset: async args => ({
      ...(await resolver(args)), sizeBytes: 100 * 1024 * 1024 + 1
    })
  }), error => error.code === "GEMINI_OMNI_SIGNED_URL_INVALID");

  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({
    prompt: "Animate this private image",
    projectId, firstFrameAssetId: imageId,
    getAuthorizedAssetContext: async args => ({ ownerId, projectId: args.projectId }),
    resolveGoogleFileAsset: async args => ({
      ...(await resolver(args)), expiresAt: new Date(Date.now() - 1000).toISOString()
    })
  }), error => error.code === "GEMINI_OMNI_SIGNED_URL_INVALID");
});

test("adds documented image_to_video and reference_to_video task hints only when needed", async () => {
  const harness = assetHarness();
  const image = await buildGeminiOmniFlashInteractionRequest({
    prompt: "Animate this frame with a slow camera push",
    projectId, firstFrameAssetId: firstId,
    getAuthorizedAssetContext: harness.getAuthorizedAssetContext,
    resolveGoogleFileAsset: harness.resolveGoogleFileAsset
  });
  assert.deepEqual(image.payload.generation_config, { video_config: { task: "image_to_video" } });
  const refs = await buildGeminiOmniFlashInteractionRequest({
    prompt: "Create a video featuring this subject",
    projectId, referenceImageAssetIds: [imageId],
    getAuthorizedAssetContext: harness.getAuthorizedAssetContext,
    resolveGoogleFileAsset: harness.resolveGoogleFileAsset
  });
  assert.deepEqual(refs.payload.generation_config, { video_config: { task: "reference_to_video" } });
});

test("supports first/last frame interpolation and bounded short reference videos", async () => {
  const harness = assetHarness();
  const result = await buildGeminiOmniFlashInteractionRequest({
    prompt: "Transition smoothly from the first frame to the last frame",
    projectId,
    firstFrameAssetId: firstId,
    lastFrameAssetId: lastId,
    referenceVideoAssetIds: [refVideoId],
    getAuthorizedAssetContext: harness.getAuthorizedAssetContext,
    resolveGoogleFileAsset: harness.resolveGoogleFileAsset
  });
  assert.deepEqual(result.payload.input.map(item => item.type), ["image", "image", "video", "text"]);
  assert.equal(Object.hasOwn(result.payload, "generation_config"), false);
  assert.equal(harness.calls.find(call => call.assetId === refVideoId).mediaType, "video");
});

test("rejects invalid operations, ratios, resolutions, interaction IDs and unsafe input combinations", async () => {
  const base = { prompt: "A short video prompt" };
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({ ...base, operation: "other" }));
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({ ...base, aspectRatio: "1:1" }));
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({ ...base, resolution: "8k" }));
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({ ...base, previousInteractionId: "not-an-id" }));
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({ ...base, operation: "edit" }));
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({ ...base, operation: "generate", sourceVideoAssetId: videoId }));
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({ ...base, operation: "edit", sourceVideoAssetId: videoId, previousInteractionId: "v1_abcdef123456" }));
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({ ...base, lastFrameAssetId: lastId }));
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({ ...base, prompt: "x".repeat(12001) }));
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({ ...base, negativePrompt: "no text" }), error => error.code === "GEMINI_OMNI_UNSUPPORTED_OPTION");
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({ ...base, durationSeconds: 8 }), error => error.code === "GEMINI_OMNI_UNSUPPORTED_OPTION");
});

test("fails closed when private asset authorization or Google Files URI validation fails", async () => {
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({
    prompt: "A person walks", projectId, referenceImageAssetIds: [imageId],
    resolveGoogleFileAsset: async () => ({ uri: googleUri(imageId), mediaType: "image" })
  }), error => error.code === "GEMINI_OMNI_ASSET_GATES_MISSING");

  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({
    prompt: "A person walks", projectId, referenceImageAssetIds: [imageId],
    getAuthorizedAssetContext: async () => { throw new Error("denied"); },
    resolveGoogleFileAsset: async () => ({ uri: googleUri(imageId), mediaType: "image" })
  }), error => error.code === "GEMINI_OMNI_ASSET_FORBIDDEN");

  const harness = assetHarness({ [imageId]: { uri: "https://attacker.example/file" } });
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({
    prompt: "A person walks", projectId, referenceImageAssetIds: [imageId],
    getAuthorizedAssetContext: harness.getAuthorizedAssetContext,
    resolveGoogleFileAsset: harness.resolveGoogleFileAsset
  }), error => error.code === "GEMINI_OMNI_ASSET_INVALID");
});

test("enforces uploaded source video and reference video duration limits", async () => {
  const tooLongSource = assetHarness({ [videoId]: { durationSeconds: 10.1 } });
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({
    prompt: "Edit the video", operation: "edit", projectId, sourceVideoAssetId: videoId,
    getAuthorizedAssetContext: tooLongSource.getAuthorizedAssetContext,
    resolveGoogleFileAsset: tooLongSource.resolveGoogleFileAsset
  }));

  const tooLongReference = assetHarness({ [refVideoId]: { durationSeconds: 3.1 } });
  await assert.rejects(() => buildGeminiOmniFlashInteractionRequest({
    prompt: "Use this as a reference", projectId, referenceVideoAssetIds: [refVideoId],
    getAuthorizedAssetContext: tooLongReference.getAuthorizedAssetContext,
    resolveGoogleFileAsset: tooLongReference.resolveGoogleFileAsset
  }));
});

test("normalizes raw REST base64 output and does not rely on SDK-only output_video", () => {
  const result = normalizeGeminiOmniFlashInteractionResponse({
    id: "v1_abcdef123456",
    model: "gemini-omni-1.1-flash",
    status: "completed",
    steps: [{
      type: "model_output",
      content: [{ type: "video", mime_type: "video/mp4", data: "AAAA" }]
    }]
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.video, {
    mimeType: "video/mp4", delivery: "inline", base64: "AAAA", byteLength: 3
  });
});

test("normalizes Google Files URI output and maps asynchronous statuses", () => {
  const result = normalizeGeminiOmniFlashInteractionResponse({
    id: "v1_abcdef123456",
    model: "gemini-omni-1.1-flash",
    status: "in_progress",
    steps: [{
      type: "model_output",
      content: [{ type: "video", mime_type: "video/mp4", uri: googleUri("abc123") + ":download?alt=media" }]
    }]
  });
  assert.equal(result.status, "running");
  assert.deepEqual(result.video, {
    mimeType: "video/mp4", delivery: "uri", uri: googleUri("abc123") + ":download?alt=media"
  });
});

test("rejects malformed, oversized or completed-without-output REST responses", () => {
  const response = {
    id: "v1_abcdef123456",
    model: "gemini-omni-1.1-flash",
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data: "AAAA" }] }]
  };
  assert.throws(() => normalizeGeminiOmniFlashInteractionResponse({
    ...response, steps: [{ type: "model_output", content: [] }]
  }), error => error.code === "GEMINI_OMNI_MISSING_OUTPUT");
  assert.throws(() => normalizeGeminiOmniFlashInteractionResponse(response, { maxInlineVideoBytes: 2 }),
    error => error.code === "GEMINI_OMNI_RESPONSE_TOO_LARGE");
  assert.throws(() => normalizeGeminiOmniFlashInteractionResponse({
    ...response, steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/webm", data: "AAAA" }] }]
  }), error => error.code === "GEMINI_OMNI_INVALID_RESPONSE");
  assert.throws(() => normalizeGeminiOmniFlashInteractionResponse({
    ...response, steps: [{ type: "model_output", content: [{ type: "video", mime_type: "video/mp4", data: "not base64!" }] }]
  }), error => error.code === "GEMINI_OMNI_INVALID_RESPONSE");
  assert.throws(() => normalizeGeminiOmniFlashInteractionResponse({
    ...response, id: "bad-id"
  }), error => error.code === "GEMINI_OMNI_INVALID_RESPONSE");
});

test("normalizes requires_action and leaves undocumented queued state unknown", () => {
  const waiting = normalizeGeminiOmniFlashInteractionResponse({
    id: "v1_abcdef123456",
    model: "gemini-omni-1.1-flash",
    status: "requires_action",
    steps: []
  });
  assert.equal(waiting.status, "waiting");
  const undocumented = normalizeGeminiOmniFlashInteractionResponse({
    id: "v1_abcdef123456",
    model: "gemini-omni-1.1-flash",
    status: "queued",
    steps: []
  });
  assert.equal(undocumented.status, "unknown");
});
