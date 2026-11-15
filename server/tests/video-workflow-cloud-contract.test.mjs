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

test("builds a deterministic Gemini Omni text-to-video request with bounded 720p pricing inputs",()=>{
 const googleNode={id:"google-video-1",kind:"video.generate",config:{provider:"google",model:"gemini-omni-1.1-flash",durationSeconds:5,aspectRatio:"16:9",resolution:"720p",rightsConfirmed:true}};
 const request={node:googleNode,projectId:"project-1",requestId:"workflow-run-1:google-video-1",values:{prompt:"A cinematic sunrise over Kampala"}};
 const first=createVideoWorkflowCloudRequest(request),second=createVideoWorkflowCloudRequest(request);
 assert.equal(first.provider,"google");assert.equal(first.model,"gemini-omni-1.1-flash");
 assert.equal(first.operation,"generate");assert.equal(first.input.operation,"generate");
 assert.equal(first.input.durationSeconds,5);assert.equal(first.input.resolution,"720p");
 assert.equal(first.requestHash,second.requestHash);assert.match(first.requestHash,/^[a-f0-9]{64}$/);
 assert.equal(first.input.requestHash,first.requestHash);assert.equal(first.input.rightsConfirmed,true);
});
test("maps Gemini Omni first-frame and reference assets to the immutable cloud input",()=>{
 const result=createVideoWorkflowCloudRequest({
  node:{kind:"video.generate",config:{provider:"google",model:"gemini-omni-1.1-flash",durationSeconds:5,firstFrameAssetId:"first-frame",referenceImageAssetIds:["reference-image"]}},
  projectId:"project-1",requestId:"google-image-workflow",
  values:{prompt:"Animate this scene"}
 });
 assert.equal(result.operation,"generate");assert.equal(result.input.startFrameAssetId,"first-frame");
 assert.deepEqual(result.input.referenceImageAssetIds,["reference-image"]);
});
test("maps Gemini Omni source-video editing and prior-interaction extension",()=>{
 const edited=createVideoWorkflowCloudRequest({
  node:{kind:"video.generate",config:{provider:"google",model:"gemini-omni-1.1-flash",operation:"edit",durationSeconds:5}},
  projectId:"project-1",requestId:"google-edit-workflow",
  values:{prompt:"Replace the background",sourceVideoAssetId:"source-video"}
 });
 assert.equal(edited.operation,"edit");assert.equal(edited.input.sourceVideoAssetId,"source-video");
 const extended=createVideoWorkflowCloudRequest({
  node:{kind:"video.generate",config:{provider:"google",model:"gemini-omni-1.1-flash",operation:"extend",durationSeconds:5}},
  projectId:"project-1",requestId:"google-extend-workflow",
  values:{prompt:"Continue the shot",previousInteractionId:"v1_abcdef123456"}
 });
 assert.equal(extended.operation,"extend");assert.equal(extended.input.previousInteractionId,"v1_abcdef123456");
});
test("Gemini Omni workflow contract rejects unsupported audio, last-frame, duration and resolution inputs",()=>{
 const baseGoogle={node:{kind:"video.generate",config:{provider:"google",model:"gemini-omni-1.1-flash",durationSeconds:5}},projectId:"project-1",requestId:"google-invalid",values:{prompt:"A scene"}};
 assert.throws(()=>createVideoWorkflowCloudRequest({...baseGoogle,values:{...baseGoogle.values,referenceAudioAssetIds:["audio-1"]}}),/reference-audio/);
 assert.throws(()=>createVideoWorkflowCloudRequest({...baseGoogle,node:{...baseGoogle.node,config:{...baseGoogle.node.config,lastFrameAssetId:"last-frame"}}}),/last-frame/);
 assert.throws(()=>createVideoWorkflowCloudRequest({...baseGoogle,node:{...baseGoogle.node,config:{...baseGoogle.node.config,durationSeconds:11}}}),error=>error.code==="VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
 assert.throws(()=>createVideoWorkflowCloudRequest({...baseGoogle,node:{...baseGoogle.node,config:{...baseGoogle.node.config,resolution:"1080p"}}}),error=>error.code==="VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
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

test("builds exact Luma Ray 3.2 text-to-video and image-to-video contracts",()=>{
 const lumaNode={id:"luma-video-1",kind:"video.generate",config:{provider:"luma",model:"ray-3.2",durationSeconds:5,aspectRatio:"9:16",resolution:"720p"}};
 const textRequest=createVideoWorkflowCloudRequest({node:lumaNode,projectId:"project-1",requestId:"luma-text-1",values:{prompt:"A cinematic city scene"}});
 assert.equal(textRequest.provider,"luma");
 assert.equal(textRequest.model,"ray-3.2");
 assert.equal(textRequest.operation,"generate");
 assert.equal(textRequest.input.operation,"generate");
 assert.equal(textRequest.input.durationSeconds,5);
 assert.equal(textRequest.input.resolution,"720p");
 assert.equal(textRequest.input.audioMode,"none");
 const imageRequest=createVideoWorkflowCloudRequest({
  node:{...lumaNode,config:{...lumaNode.config,rightsConfirmed:true,referenceAssetId:"frame-asset"}},
  projectId:"project-1",requestId:"luma-image-1",values:{prompt:"Animate this frame"}
 });
 assert.equal(imageRequest.operation,"generate");
 assert.equal(imageRequest.input.startFrameAssetId,"frame-asset");
 assert.equal(imageRequest.input.rightsConfirmed,true);
 assert.match(imageRequest.requestHash,/^[a-f0-9]{64}$/);
});

test("builds immutable Luma multi-keyframe workflow inputs with rights and ordered frame indexes",()=>{
 const node={kind:"video.generate",config:{provider:"luma",model:"ray-3.2",durationSeconds:10,resolution:"720p",aspectRatio:"16:9",rightsConfirmed:true,keyframeAssetIds:["frame-a","frame-b","frame-c"],keyframeIndexes:[0,72,240]}};
 const request=createVideoWorkflowCloudRequest({node,projectId:"project-1",requestId:"luma-keyframes-1",values:{prompt:"A continuous cinematic camera move"}});
 assert.deepEqual(request.input.keyframeAssetIds,["frame-a","frame-b","frame-c"]);
 assert.deepEqual(request.input.keyframeIndexes,[0,72,240]);
 assert.equal(request.input.rightsConfirmed,true);
 assert.match(request.requestHash,/^[a-f0-9]{64}$/);
 assert.equal(Object.isFrozen(request.input.keyframeAssetIds),true);
});
test("Luma five-second workflow supports private first and last frame anchors",()=>{
 const request=createVideoWorkflowCloudRequest({node:{kind:"video.generate",config:{
  provider:"luma",model:"ray-3.2",durationSeconds:5,resolution:"720p",aspectRatio:"16:9",
  rightsConfirmed:true,startFrameAssetId:"frame-first",endFrameAssetId:"frame-last"
 }},projectId:"project-1",requestId:"luma-first-last-1",values:{prompt:"Move from the opening frame to the final composition"}});
 assert.equal(request.input.startFrameAssetId,"frame-first");
 assert.equal(request.input.endFrameAssetId,"frame-last");
 assert.equal(request.input.rightsConfirmed,true);
});
test("Luma ten-second workflow requires multi-keyframe mode instead of first/last anchors",()=>{
 assert.throws(()=>createVideoWorkflowCloudRequest({node:{kind:"video.generate",config:{
  provider:"luma",model:"ray-3.2",durationSeconds:10,resolution:"720p",aspectRatio:"16:9",
  rightsConfirmed:true,startFrameAssetId:"frame-first",endFrameAssetId:"frame-last"
 }},projectId:"project-1",requestId:"luma-first-last-10",values:{prompt:"A scene"}}),error=>error.code==="VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
});
test("Luma source-video edit and reframe contracts bind private assets and operation-specific controls",()=>{
 const sourceVideoAssetId="b23e4567-e89b-42d3-a456-426614174010";
 const edited=createVideoWorkflowCloudRequest({
  node:{kind:"video.generate",config:{provider:"luma",model:"ray-3.2",operation:"edit",durationSeconds:5,resolution:"720p",aspectRatio:"16:9",editStrength:"reimagine_2",sourceVideoAssetId,rightsConfirmed:true}},
  projectId:"project-1",requestId:"luma-edit-1",values:{prompt:"Replace the background while preserving subject motion"}
 });
 assert.equal(edited.operation,"video_edit");
 assert.equal(edited.input.operation,"edit");
 assert.equal(edited.input.sourceVideoAssetId,sourceVideoAssetId);
 assert.equal(edited.input.editStrength,"reimagine_2");
 const reframed=createVideoWorkflowCloudRequest({
  node:{kind:"video.generate",config:{provider:"luma",model:"ray-3.2",operation:"reframe",durationSeconds:13,resolution:"540p",aspectRatio:"9:16",sourceVideoAssetId,sourcePosition:{x_norm:0.1,y_norm:-0.2,w_norm:0.8,h_norm:1.2},rightsConfirmed:true}},
  projectId:"project-1",requestId:"luma-reframe-1",values:{prompt:"Recompose for vertical social video"}
 });
 assert.equal(reframed.operation,"video_reframe");
 assert.equal(reframed.input.operation,"reframe");
 assert.deepEqual(reframed.input.sourcePosition,{x_norm:0.1,y_norm:-0.2,w_norm:0.8,h_norm:1.2});
});
test("Luma source-video edit and reframe reject missing sources, generation anchors and unverified tiers",()=>{
 const base={node:{kind:"video.generate",config:{provider:"luma",model:"ray-3.2",operation:"edit",durationSeconds:5,resolution:"720p",rightsConfirmed:true}},projectId:"project-1",requestId:"luma-source-invalid",values:{prompt:"Edit the shot"}};
 assert.throws(()=>createVideoWorkflowCloudRequest(base),error=>error.code==="VIDEO_WORKFLOW_CLOUD_OPERATION_MISMATCH");
 assert.throws(()=>createVideoWorkflowCloudRequest({...base,node:{...base.node,config:{...base.node.config,sourceVideoAssetId:"source",keyframeAssetIds:["frame"],keyframeIndexes:[0]}}}),/cannot be combined with generation frame anchors/);
 assert.throws(()=>createVideoWorkflowCloudRequest({...base,node:{...base.node,config:{...base.node.config,operation:"reframe",durationSeconds:13,resolution:"1080p",sourceVideoAssetId:"source"}}}),/1080p reframe is not enabled/);
 assert.throws(()=>createVideoWorkflowCloudRequest({...base,node:{...base.node,config:{...base.node.config,operation:"extend",sourceVideoAssetId:"source"}}}),/extension remains gated/);
});
test("Luma multi-keyframe workflow rejects mismatched, unordered, duplicate and unlicensed frames",()=>{
 const base={node:{kind:"video.generate",config:{provider:"luma",model:"ray-3.2",durationSeconds:5,rightsConfirmed:true,keyframeAssetIds:["a","b"],keyframeIndexes:[0,24]}},projectId:"project-1",requestId:"luma-invalid-frames",values:{prompt:"A scene"}};
 assert.throws(()=>createVideoWorkflowCloudRequest({...base,node:{...base.node,config:{...base.node.config,keyframeIndexes:[0]}}}),/matching output-frame index/);
 assert.throws(()=>createVideoWorkflowCloudRequest({...base,node:{...base.node,config:{...base.node.config,keyframeIndexes:[24,0]}}}),/strictly increasing/);
 assert.throws(()=>createVideoWorkflowCloudRequest({...base,node:{...base.node,config:{...base.node.config,keyframeAssetIds:["a","a"]}}}),/duplicate asset IDs/);
 assert.throws(()=>createVideoWorkflowCloudRequest({...base,node:{...base.node,config:{...base.node.config,rightsConfirmed:false}}}),error=>error.code==="MEDIA_RIGHTS_REQUIRED");
 assert.throws(()=>createVideoWorkflowCloudRequest({...base,node:{...base.node,config:{...base.node.config,startFrameAssetId:"start"}}}),/cannot be combined/);
});
test("Luma workflow contract rejects unpriced, unsupported or unscoped source operations",()=>{
 const lumaBase={node:{kind:"video.generate",config:{provider:"luma",model:"ray-3.2",durationSeconds:5}},projectId:"project-1",requestId:"luma-invalid",values:{prompt:"A scene"}};
 assert.throws(()=>createVideoWorkflowCloudRequest({...lumaBase,node:{...lumaBase.node,config:{...lumaBase.node.config,resolution:"4k"}}}),error=>error.code==="VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
 assert.throws(()=>createVideoWorkflowCloudRequest({...lumaBase,values:{...lumaBase.values,sourceVideoAssetId:"source-video"}}),error=>error.code==="VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
 assert.throws(()=>createVideoWorkflowCloudRequest({...lumaBase,values:{...lumaBase.values,referenceAssetIds:["generic-reference"]}}),error=>error.code==="VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
 assert.throws(()=>createVideoWorkflowCloudRequest({...lumaBase,node:{...lumaBase.node,config:{...lumaBase.node.config,rightsConfirmed:false,referenceAssetId:"frame-asset"}}}),error=>error.code==="MEDIA_RIGHTS_REQUIRED");
});
