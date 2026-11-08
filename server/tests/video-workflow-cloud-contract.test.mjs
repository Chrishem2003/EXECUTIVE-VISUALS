import test from "node:test";
import assert from "node:assert/strict";
import { createVideoWorkflowCloudRequest } from "../video-workflow-cloud-contract.mjs";
import { createRunwaySourceAssetResolver } from "../runway-source-asset-resolver.mjs";

const node = { id: "video-1", kind: "video.generate", config: {
  provider: "runway", model: "model-router", durationSeconds: 8, aspectRatio: "16:9"
} };
const base = {
  node, projectId: "project-1", requestId: "workflow-run-1:video-1",
  values: { prompt: "A cinematic product launch" }
};

test("builds deterministic text-to-video contract for the exact router adapter", () => {
  const first = createVideoWorkflowCloudRequest(base);
  const second = createVideoWorkflowCloudRequest(base);
  assert.equal(first.provider, "runway");
  assert.equal(first.model, "model-router");
  assert.equal(first.operation, "text-to-video");
  assert.equal(first.input.durationSeconds, 8);
  assert.equal(first.requestHash, second.requestHash);
  assert.match(first.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(first.input.requestHash, first.requestHash);
});

test("deep-freezes nested request data so approved inputs cannot mutate after hashing", () => {
  const result = createVideoWorkflowCloudRequest({
    ...base,
    values: { prompt: "Animate the product", referenceImageAssetIds: ["asset-ref-1"] }
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.input), true);
  assert.equal(Object.isFrozen(result.input.referenceAssetIds), true);
  assert.throws(() => result.input.referenceAssetIds.push("asset-ref-2"), TypeError);
  assert.throws(() => { result.input.prompt = "Changed after quote"; }, TypeError);
  assert.equal(result.input.requestHash, result.requestHash);
});

test("maps one first-frame asset to image-to-video without resolving private storage", () => {
  const result = createVideoWorkflowCloudRequest({
    ...base, values: { prompt: "Animate the product", "start-frame": "asset-image-1" }
  });
  assert.equal(result.operation, "image-to-video");
  assert.equal(result.input.startFrameAssetId, "asset-image-1");
});

test("maps existing image/reference workflow ports and numeric UI duration values", () => {
  const result = createVideoWorkflowCloudRequest({
    ...base,
    node: { ...node, config: { ...node.config, durationSeconds: undefined, duration: "10" } },
    values: { prompt: "Animate the image", image: "asset-image-2" }
  });
  assert.equal(result.operation, "image-to-video");
  assert.equal(result.input.startFrameAssetId, "asset-image-2");
  assert.equal(result.input.durationSeconds, 10);
});

test("preserves the existing referenceAssetId node configuration", () => {
  const result = createVideoWorkflowCloudRequest({
    ...base,
    node: { ...node, config: { ...node.config, referenceAssetId: "asset-reference-legacy" } }
  });
  assert.equal(result.operation, "image-to-video");
  assert.equal(result.input.startFrameAssetId, "asset-reference-legacy");
});

test("maps source video to video-to-video and retains asset lineage IDs", () => {
  const result = createVideoWorkflowCloudRequest({
    ...base, values: {
      prompt: "Replace the background", sourceVideoAssetId: "asset-video-1",
      referenceImageAssetIds: ["asset-image-1"]
    }
  });
  assert.equal(result.operation, "video-to-video");
  assert.equal(result.input.sourceVideoAssetId, "asset-video-1");
  assert.deepEqual(result.input.referenceAssetIds, ["asset-image-1"]);
});

test("rejects unsupported nodes and provider/model fallbacks", () => {
  assert.throws(
    () => createVideoWorkflowCloudRequest({ ...base, node: { ...node, kind: "image.generate" } }),
    error => error.code === "VIDEO_WORKFLOW_CLOUD_NODE_UNSUPPORTED"
  );
  assert.throws(
    () => createVideoWorkflowCloudRequest({ ...base, node: { ...node, config: { provider: "fal", model: "fal-ai/video" } } }),
    error => error.code === "VIDEO_WORKFLOW_CLOUD_ADAPTER_UNAVAILABLE"
  );
});

test("requires stable request identity and a saved project", () => {
  assert.throws(
    () => createVideoWorkflowCloudRequest({ ...base, requestId: "" }),
    error => error.code === "VIDEO_WORKFLOW_CLOUD_REQUEST_ID_REQUIRED"
  );
  assert.throws(
    () => createVideoWorkflowCloudRequest({ ...base, projectId: null }),
    error => error.code === "VIDEO_WORKFLOW_CLOUD_PROJECT_REQUIRED"
  );
});

test("rejects an operation that conflicts with connected asset types", () => {
  assert.throws(
    () => createVideoWorkflowCloudRequest({
      ...base, node: { ...node, config: { ...node.config, operation: "text-to-video" } },
      values: { prompt: "Edit", sourceVideoAssetId: "asset-video-1" }
    }),
    error => error.code === "VIDEO_WORKFLOW_CLOUD_OPERATION_MISMATCH"
  );
});

test("rejects invalid router durations and unsupported reference audio combinations", () => {
  assert.throws(
    () => createVideoWorkflowCloudRequest({
      ...base, node: { ...node, config: { ...node.config, durationSeconds: 31 } }
    }),
    error => error.code === "VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED"
  );
  assert.throws(
    () => createVideoWorkflowCloudRequest({
      ...base, node: { ...node, config: { ...node.config, audioMode: "reference" } }
    }),
    /exactly one connected reference-audio asset/
  );
});


test("cloud node contract resolves through the existing owner-scoped Model Router asset resolver", async () => {
  const ownerId = "owner-1";
  const projectId = "project-1";
  const records = new Map([
    ["source-video", { id: "source-video", ownerId, projectId, storageBucket: "executive-visuals-media", objectPath: "owner/source.mp4", size: 4, mediaType: "video/mp4", name: "source.mp4" }],
    ["reference-video", { id: "reference-video", ownerId, projectId, storageBucket: "executive-visuals-media", objectPath: "owner/reference.mp4", size: 4, mediaType: "video/mp4", name: "reference.mp4" }],
    ["first-frame", { id: "first-frame", ownerId, projectId, storageBucket: "executive-visuals-media", objectPath: "owner/first.png", size: 8, mediaType: "image/png", name: "first.png" }],
    ["reference-image", { id: "reference-image", ownerId, projectId, storageBucket: "executive-visuals-media", objectPath: "owner/reference.png", size: 8, mediaType: "image/png", name: "reference.png" }],
    ["reference-audio", { id: "reference-audio", ownerId, projectId, storageBucket: "executive-visuals-media", objectPath: "owner/reference.mp3", size: 4, mediaType: "audio/mpeg", name: "reference.mp3" }]
  ]);
  const signedUrls = new Map();
  for (const asset of records.values()) {
    signedUrls.set("https://project.supabase.co/storage/v1/object/sign/" + asset.objectPath + "?token=test", asset);
  }
  const resolver = createRunwaySourceAssetResolver({
    supabaseUrl: "https://project.supabase.co",
    assets: {
      async get({ ownerId: requestedOwner, assetId }) {
        const asset = records.get(assetId);
        return asset && asset.ownerId === requestedOwner ? asset : null;
      },
      async createSignedUrl({ ownerId: requestedOwner, assetId }) {
        const asset = records.get(assetId);
        if (!asset || asset.ownerId !== requestedOwner) return null;
        return {
          asset: { id: asset.id, projectId: asset.projectId, objectPath: asset.objectPath, storageBucket: asset.storageBucket },
          url: "https://project.supabase.co/storage/v1/object/sign/" + asset.objectPath + "?token=test"
        };
      }
    },
    fetchImpl: async url => {
      const asset = signedUrls.get(String(url));
      if (!asset) return new Response("not found", { status: 404 });
      const bytes = asset.mediaType === "image/png"
        ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
        : Buffer.from("test");
      return new Response(bytes, { status: 200, headers: {
        "content-type": asset.mediaType, "content-length": String(bytes.length)
      }});
    }
  });
  const request = createVideoWorkflowCloudRequest({
    node: { ...node, config: {
      ...node.config, audioMode: "reference",
      referenceVideoAssetIds: ["reference-video"],
      referenceAudioAssetIds: ["reference-audio"]
    }},
    projectId, requestId: "workflow-run-2:video-1",
    values: {
      prompt: "Edit the source while preserving the product",
      sourceVideoAssetId: "source-video",
      startFrameAssetId: "first-frame",
      referenceImageAssetIds: ["reference-image"]
    }
  });
  const prepared = await resolver.prepare(request.input, {
    job: { owner_id: ownerId, project_id: projectId }
  });
  assert.equal(prepared.operation, "video-to-video");
  assert.equal(prepared.referenceVideos[0].role, "source");
  assert.equal(prepared.referenceVideos[1].role, "reference");
  assert.deepEqual(prepared.referenceImages.map(item => item.role), ["first", "reference"]);
  assert.equal(prepared.referenceAudio.length, 1);
  assert.match(prepared.referenceImages[0].uri, /^https:\/\/project\.supabase\.co\//);
  assert.equal(prepared.requestHash, request.requestHash);
});

test("existing source resolver rejects a cross-project workflow asset before signing or downloading", async () => {
  let signed = 0;
  const resolver = createRunwaySourceAssetResolver({
    supabaseUrl: "https://project.supabase.co",
    assets: {
      async get() {
        return { id: "foreign-image", projectId: "another-project", storageBucket: "executive-visuals-media",
          objectPath: "foreign/image.png", size: 8, mediaType: "image/png", name: "foreign.png" };
      },
      async createSignedUrl() { signed++; throw new Error("must not sign"); }
    },
    fetchImpl: async () => { throw new Error("must not download"); }
  });
  const request = createVideoWorkflowCloudRequest({
    ...base,
    values: { prompt: "Animate this reference", image: "foreign-image" }
  });
  await assert.rejects(
    resolver.prepare(request.input, { job: { owner_id: "owner-1", project_id: "project-1" } }),
    error => error.code === "VIDEO_INPUT_ASSET_RESOLUTION_FAILED"
  );
  assert.equal(signed, 0);
});

test("rejects one asset ID reused across distinct source and reference roles", () => {
  const cases = [
    {
      values: { prompt: "Edit", sourceVideoAssetId: "same", referenceVideoAssetIds: ["same"] }
    },
    {
      values: { prompt: "Animate", image: "same", referenceImageAssetIds: ["same"] }
    },
    {
      values: { prompt: "Edit", sourceVideoAssetId: "same", referenceAudioAssetIds: ["same"] },
      config: { audioMode: "reference" }
    }
  ];
  for (const item of cases) {
    const configuredNode = item.config
      ? { ...node, config: { ...node.config, ...item.config } }
      : node;
    assert.throws(
      () => createVideoWorkflowCloudRequest({
        ...base, node: configuredNode, values: item.values
      }),
      error => error.code === "VIDEO_WORKFLOW_CLOUD_ASSET_ROLE_CONFLICT"
    );
  }
});

test("rejects duplicate or excessive reference assets", () => {
  assert.throws(
    () => createVideoWorkflowCloudRequest({
      ...base, values: { prompt: "Test", references: ["a", "a"] }
    }),
    /duplicate asset IDs/
  );
  assert.throws(
    () => createVideoWorkflowCloudRequest({
      ...base, values: { prompt: "Test", references: ["a", "b", "c", "d", "e"] }
    }),
    /at most 4/
  );
});
