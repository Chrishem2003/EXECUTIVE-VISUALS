import test from "node:test";
import assert from "node:assert/strict";
import { createRunwaySourceAssetResolver } from "../runway-source-asset-resolver.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";
const bytes = Buffer.alloc(1024, 7);

function fixture({ projectId = PROJECT, mediaType = "video/mp4", signedUrl = "https://storage.example.com/storage/v1/object/sign/private/a?token=x", fetchImpl, execFileImpl } = {}) {
  const asset = {
    id: ASSET, ownerId: OWNER, projectId, name: "source.mp4", mediaType,
    size: bytes.length, storageBucket: "executive-visuals-media",
    objectPath: PROJECT + "/" + ASSET + "/original.mp4"
  };
  const calls = [];
  const assets = {
    async get(args) { calls.push(["get", args]); return asset; },
    async createSignedUrl(args) { calls.push(["sign", args]); return { asset, url: signedUrl }; }
  };
  return {
    calls,
    resolver: createRunwaySourceAssetResolver({
      assets, supabaseUrl: "https://storage.example.com",
      fetchImpl: fetchImpl || (async () => new Response(bytes, {
        status: 200, headers: { "content-type": mediaType, "content-length": String(bytes.length) }
      })),
      execFileImpl: execFileImpl || ((_path, _args, _options, callback) => callback(null, JSON.stringify({
        format: { duration: "11.2" },
        streams: [{ codec_type: "video", width: 1920, height: 1080, nb_read_frames: "336", avg_frame_rate: "30/1", r_frame_rate: "30/1", color_transfer: "bt709", color_primaries: "bt709", color_space: "bt709" }]
      })))
    })
  };
}

test("Runway source preparation reads only authorized project-scoped private assets", async () => {
  const { resolver, calls } = fixture();
  const result = await resolver.prepare({ operation: "video-to-video", projectId: PROJECT, sourceVideoAssetId: ASSET }, {
    job: { owner_id: OWNER }
  });
  assert.equal(result.sourceVideo.buffer.length, bytes.length);
  assert.equal(result.sourceVideo.mimeType, "video/mp4");
  assert.equal(calls[0][1].ownerId, OWNER);
  assert.equal(calls[1][1].ownerId, OWNER);
  assert.equal(calls[1][1].expiresIn, 300);
});

test("Runway source preparation rejects cross-project asset references", async () => {
  const { resolver } = fixture();
  await assert.rejects(
    () => resolver.prepare({ operation: "video-to-video", projectId: "44444444-4444-4444-8444-444444444444", sourceVideoAssetId: ASSET }, { job: { owner_id: OWNER } }),
    error => error.code === "VIDEO_INPUT_ASSET_RESOLUTION_FAILED"
  );
});

test("Runway source preparation rejects untrusted signed URL origins before fetching", async () => {
  let fetched = false;
  const { resolver } = fixture({
    signedUrl: "https://attacker.example/storage/v1/object/sign/private/a",
    fetchImpl: async () => { fetched = true; return new Response(bytes); }
  });
  await assert.rejects(
    () => resolver.prepare({ operation: "video-to-video", projectId: PROJECT, sourceVideoAssetId: ASSET }, { job: { owner_id: OWNER } }),
    error => error.code === "VIDEO_INPUT_ASSET_RESOLUTION_FAILED"
  );
  assert.equal(fetched, false);
});

test("Runway source preparation validates content type and byte length against asset metadata", async () => {
  const { resolver } = fixture({
    fetchImpl: async () => new Response(bytes, {
      status: 200, headers: { "content-type": "video/webm", "content-length": String(bytes.length) }
    })
  });
  await assert.rejects(
    () => resolver.prepare({ operation: "video-to-video", projectId: PROJECT, sourceVideoAssetId: ASSET }, { job: { owner_id: OWNER } }),
    error => error.code === "VIDEO_INPUT_ASSET_INTEGRITY_FAILED"
  );
});

test("Runway metadata resolver probes the private source and returns authoritative duration, frame count and dynamic range", async () => {
  const { resolver } = fixture();
  const result = await resolver.resolveMetadata({ ownerId: OWNER, projectId: PROJECT, assetId: ASSET });
  assert.equal(result.ownerId, OWNER);
  assert.equal(result.projectId, PROJECT);
  assert.equal(result.durationSeconds, 11.2);
  assert.equal(result.frameCount, 336);
  assert.equal(result.frameRate, 30);
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1080);
  assert.equal(result.sourceWidth, 1920);
  assert.equal(result.sourceHeight, 1080);
  assert.equal(result.sourceDynamicRange, "sdr");
});

test("Runway source resolver rejects image assets for video source operations", async () => {
  const { resolver } = fixture({ mediaType: "image/png" });
  await assert.rejects(
    () => resolver.resolveMetadata({ ownerId: OWNER, projectId: PROJECT, assetId: ASSET }),
    error => error.code === "VIDEO_INPUT_ASSET_TYPE_INVALID"
  );
});


test("Runway video edits resolve ordered keyframe images from the same private project", async () => {
  const imageOne = "44444444-4444-4444-8444-444444444444";
  const imageTwo = "55555555-5555-4555-8555-555555555555";
  const imageBytes = Buffer.alloc(2048, 9);
  const assetById = new Map([
    [ASSET, { id: ASSET, ownerId: OWNER, projectId: PROJECT, name: "source.mp4", mediaType: "video/mp4", size: bytes.length, storageBucket: "executive-visuals-media", objectPath: PROJECT + "/" + ASSET + "/original.mp4" }],
    [imageOne, { id: imageOne, ownerId: OWNER, projectId: PROJECT, name: "frame-one.png", mediaType: "image/png", size: imageBytes.length, storageBucket: "executive-visuals-media", objectPath: PROJECT + "/" + imageOne + "/original.png" }],
    [imageTwo, { id: imageTwo, ownerId: OWNER, projectId: PROJECT, name: "frame-two.png", mediaType: "image/png", size: imageBytes.length, storageBucket: "executive-visuals-media", objectPath: PROJECT + "/" + imageTwo + "/original.png" }]
  ]);
  const assets = {
    async get({ assetId }) { return assetById.get(assetId); },
    async createSignedUrl({ assetId }) {
      return { asset: assetById.get(assetId), url: "https://storage.example.com/storage/v1/object/sign/private/" + assetId + "?token=valid" };
    }
  };
  const resolver = createRunwaySourceAssetResolver({
    assets, supabaseUrl: "https://storage.example.com",
    fetchImpl: async url => {
      const image = String(url).includes(imageOne) || String(url).includes(imageTwo);
      return new Response(image ? imageBytes : bytes, {
        status: 200, headers: { "content-type": image ? "image/png" : "video/mp4", "content-length": String(image ? imageBytes.length : bytes.length) }
      });
    }
  });
  const result = await resolver.prepare({
    operation: "video-to-video", projectId: PROJECT, sourceVideoAssetId: ASSET,
    keyframes: [{ assetId: imageOne, at: 1.25 }, { assetId: imageTwo, at: 8.5 }]
  }, { job: { owner_id: OWNER } });
  assert.equal(result.keyframes.length, 2);
  assert.deepEqual(result.keyframes.map(frame => frame.at), [1.25, 8.5]);
  assert.deepEqual(result.keyframes.map(frame => frame.mimeType), ["image/png", "image/png"]);
  assert.equal(result.keyframes[0].buffer.length, imageBytes.length);
});

test("Runway Model Router references are converted only from owner/project-scoped private image and video assets", async () => {
  const imageId = "44444444-4444-4444-8444-444444444444";
  const videoId = "55555555-5555-4555-8555-555555555555";
  const byId = new Map([
    [imageId, { id: imageId, projectId: PROJECT, name: "ref.png", mediaType: "image/png", size: 1024, storageBucket: "executive-visuals-media", objectPath: PROJECT + "/" + imageId + "/original.png" }],
    [videoId, { id: videoId, projectId: PROJECT, name: "ref.mp4", mediaType: "video/mp4", size: 1024, storageBucket: "executive-visuals-media", objectPath: PROJECT + "/" + videoId + "/original.mp4" }]
  ]);
  const resolver = createRunwaySourceAssetResolver({
    assets: {
      async get({ ownerId, assetId }) { assert.equal(ownerId, OWNER); return byId.get(assetId); },
      async createSignedUrl({ ownerId, assetId, expiresIn }) {
        assert.equal(ownerId, OWNER); assert.equal(expiresIn, 300);
        return { asset: byId.get(assetId), url: "https://storage.example.com/storage/v1/object/sign/private/" + assetId + "?token=private" };
      }
    },
    supabaseUrl: "https://storage.example.com",
    fetchImpl: async url => new Response(bytes, { status: 200, headers: { "content-type": String(url).includes(videoId) ? "video/mp4" : "image/png", "content-length": String(bytes.length) } })
  });
  const prepared = await resolver.prepare({
    provider: "runway", model: "model-router", operation: "text-to-video",
    projectId: PROJECT, referenceImageAssetIds: [imageId], referenceVideoAssetIds: [videoId]
  }, { job: { owner_id: OWNER } });
  assert.equal(prepared.referenceImages[0].uri, "https://storage.example.com/storage/v1/object/sign/private/" + imageId + "?token=private");
  assert.equal(prepared.referenceImages[0].role, "reference");
  assert.equal(prepared.referenceVideos[0].uri, "https://storage.example.com/storage/v1/object/sign/private/" + videoId + "?token=private");
  assert.equal(prepared.referenceVideos[0].role, "reference");
});

test("Runway Model Router resolves exactly one owner/project-scoped private reference audio asset", async () => {
  const audioId = "66666666-6666-4666-8666-666666666666";
  const audioBytes = Buffer.from("validated-audio-reference");
  const asset = { id: audioId, projectId: PROJECT, name: "voice.mp3", mediaType: "audio/mpeg", size: audioBytes.length, storageBucket: "executive-visuals-media", objectPath: PROJECT + "/" + audioId + "/original.mp3" };
  const resolver = createRunwaySourceAssetResolver({
    assets: {
      async get({ ownerId, assetId }) { assert.equal(ownerId, OWNER); assert.equal(assetId, audioId); return asset; },
      async createSignedUrl({ ownerId, assetId, expiresIn }) {
        assert.equal(ownerId, OWNER); assert.equal(assetId, audioId); assert.equal(expiresIn, 300);
        return { asset, url: "https://storage.example.com/storage/v1/object/sign/private/" + audioId + "?token=audio" };
      }
    },
    supabaseUrl: "https://storage.example.com",
    fetchImpl: async () => new Response(audioBytes, { status: 200, headers: { "content-type": "audio/mpeg", "content-length": String(audioBytes.length) } })
  });
  const prepared = await resolver.prepare({
    provider: "runway", model: "model-router", operation: "text-to-video",
    projectId: PROJECT, audioMode: "reference", referenceAudioAssetIds: [audioId]
  }, { job: { owner_id: OWNER } });
  assert.deepEqual(prepared.referenceAudio, [{
    uri: "https://storage.example.com/storage/v1/object/sign/private/" + audioId + "?token=audio"
  }]);
});

test("Runway Model Router rejects reference audio mode without a private audio asset", async () => {
  const resolver = createRunwaySourceAssetResolver({
    assets: { async get() { throw new Error("must not resolve"); }, async createSignedUrl() { throw new Error("must not sign"); } },
    supabaseUrl: "https://storage.example.com",
    fetchImpl: async () => { throw new Error("must not download"); }
  });
  await assert.rejects(
    resolver.prepare({
      provider: "runway", model: "model-router", projectId: PROJECT,
      audioMode: "reference", referenceAudioAssetIds: []
    }, { job: { owner_id: OWNER } }),
    error => error.code === "VIDEO_INPUT_ASSET_RESOLUTION_FAILED"
  );
});

test("Runway Model Router resolves a private source video with source role", async () => {
  const { resolver } = fixture();
  const prepared = await resolver.prepare({
    provider: "runway", model: "model-router", operation: "video-to-video",
    projectId: PROJECT, sourceVideoAssetId: ASSET, prompt: "Restyle the source clip"
  }, { job: { owner_id: OWNER } });
  assert.equal(prepared.referenceVideos.length, 1);
  assert.equal(prepared.referenceVideos[0].role, "source");
  assert.match(prepared.referenceVideos[0].uri, /^https:\/\/storage\.example\.com\//);
});



test("Runway source resolver enforces the stored byte ceiling while streaming responses without Content-Length", async () => {
  const oversized = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.alloc(bytes.length, 1));
      controller.enqueue(Buffer.from([2]));
      controller.close();
    }
  }), { status: 200, headers: { "content-type": "video/mp4" } });
  const { resolver } = fixture({ fetchImpl: async () => oversized });
  await assert.rejects(
    () => resolver.prepare({
      operation: "video-to-video", projectId: PROJECT, sourceVideoAssetId: ASSET
    }, { job: { owner_id: OWNER } }),
    error => error.code === "VIDEO_INPUT_ASSET_INTEGRITY_FAILED"
  );
});

test("Runway source resolver accepts chunked private assets when streamed bytes match the stored size", async () => {
  const chunked = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 128));
      controller.enqueue(bytes.subarray(128, 700));
      controller.enqueue(bytes.subarray(700));
      controller.close();
    }
  }), { status: 200, headers: { "content-type": "video/mp4" } });
  const { resolver } = fixture({ fetchImpl: async () => chunked });
  const result = await resolver.prepare({
    operation: "video-to-video", projectId: PROJECT, sourceVideoAssetId: ASSET
  }, { job: { owner_id: OWNER } });
  assert.equal(result.sourceVideo.buffer.length, bytes.length);
  assert.deepEqual(result.sourceVideo.buffer, bytes);
});


test("Runway source resolver normalizes failures raised after private download headers", async () => {
  const interrupted = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 100));
      controller.error(new Error("simulated storage stream interruption"));
    }
  }), { status: 200, headers: { "content-type": "video/mp4" } });
  const { resolver } = fixture({ fetchImpl: async () => interrupted });
  await assert.rejects(
    () => resolver.prepare({
      operation: "video-to-video", projectId: PROJECT, sourceVideoAssetId: ASSET
    }, { job: { owner_id: OWNER } }),
    error => error.code === "VIDEO_INPUT_ASSET_DOWNLOAD_FAILED"
  );
});
