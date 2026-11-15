import { createHash } from "node:crypto";
import { normalizeVideoGenerationRequest } from "./video-generation-contract.mjs";

const fail = (message, code = "VIDEO_WORKFLOW_CLOUD_CONTRACT_INVALID") =>
  Object.assign(new Error(message), { code });

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assetList(value, label, maximum) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maximum ||
      value.some(item => typeof item !== "string" || !item.trim())) {
    throw fail(label + " must contain at most " + maximum + " non-empty asset IDs.");
  }
  const ids = value.map(item => item.trim());
  if (new Set(ids).size !== ids.length) throw fail(label + " cannot contain duplicate asset IDs.");
  return ids;
}

function createGoogleOmniWorkflowRequest({node,values,config,projectId,requestId}){
  const prompt=firstString(values.prompt,values.text,values.input,config.prompt);
  const sourceVideoAssetId=firstString(values.sourceVideoAssetId,values.sourceVideo,values.video,config.sourceVideoAssetId);
  const startFrameAssetId=firstString(values.startFrameAssetId,values["start-frame"],values.image,values.referenceImage,values.reference,
    config.firstFrameAssetId,config.startFrameAssetId,config.referenceAssetId);
  const referenceImageAssetIds=assetList(
    config.referenceImageAssetIds??values.referenceImageAssetIds??values.references,
    "Gemini Omni reference images",5
  );
  const referenceVideoAssetIds=assetList(
    config.referenceVideoAssetIds??values.referenceVideoAssetIds,
    "Gemini Omni reference videos",3
  );
  const referenceAudioAssetIds=assetList(
    config.referenceAudioAssetIds??values.referenceAudioAssetIds,
    "Gemini Omni reference audio",1
  );
  const previousInteractionId=firstString(config.previousInteractionId,values.previousInteractionId);
  if(firstString(config.lastFrameAssetId,config.endFrameAssetId,values.lastFrameAssetId,values.endFrameAssetId,values["last-frame"]))
    throw fail("Gemini Omni last-frame locking is not yet supported by the workflow contract.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  const operation=firstString(config.operation)||(sourceVideoAssetId||previousInteractionId?"edit":"generate");
  const allAssetIds=[sourceVideoAssetId,startFrameAssetId,...referenceImageAssetIds,...referenceVideoAssetIds,...referenceAudioAssetIds].filter(Boolean);
  if(new Set(allAssetIds).size!==allAssetIds.length)throw fail("A Gemini Omni asset cannot be assigned to more than one source/reference role.","VIDEO_WORKFLOW_CLOUD_ASSET_ROLE_CONFLICT");
  if(!prompt)throw fail("Gemini Omni video generation requires a non-empty prompt.","PROMPT_REQUIRED");
  if(!["generate","edit","extend"].includes(operation))throw fail("Gemini Omni operation must be generate, edit or extend.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  if(operation==="generate"&&(sourceVideoAssetId||previousInteractionId))throw fail("Gemini Omni generate mode cannot include a source video or previous interaction.","VIDEO_WORKFLOW_CLOUD_OPERATION_MISMATCH");
  if(["edit","extend"].includes(operation)&&!sourceVideoAssetId&&!previousInteractionId)throw fail("Gemini Omni edit and extend require a source video or previous interaction.","VIDEO_WORKFLOW_CLOUD_OPERATION_MISMATCH");
  if(sourceVideoAssetId&&startFrameAssetId)throw fail("Gemini Omni source-video and first-frame inputs must be separate operations.","VIDEO_WORKFLOW_CLOUD_OPERATION_MISMATCH");
  if(referenceAudioAssetIds.length||config.audioMode==="reference"||values.audioMode==="reference")throw fail("Gemini Omni workflow quotes do not yet support reference-audio inputs.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  const durationSeconds=Number(config.durationSeconds??config.duration??5);
  if(!Number.isInteger(durationSeconds)||durationSeconds<3||durationSeconds>10)throw fail("Gemini Omni duration must be between 3 and 10 seconds.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  const aspectRatio=String(config.aspectRatio??"16:9");
  if(!["16:9","9:16"].includes(aspectRatio))throw fail("Gemini Omni supports 16:9 or 9:16 output only.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  const resolution=String(config.resolution??"720p");
  if(!["provider_default","720p"].includes(resolution))throw fail("Gemini Omni workflow quotes currently support 720p output only.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  if(1+(sourceVideoAssetId?1:0)+(startFrameAssetId?1:0)+referenceImageAssetIds.length+referenceVideoAssetIds.length>10)
    throw fail("Gemini Omni workflow input exceeds the ten-part limit.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  const normalized={
    requestId,projectId:projectId.trim(),provider:"google",model:"gemini-omni-1.1-flash",
    operation,prompt,durationSeconds,aspectRatio,resolution,
    rightsConfirmed:config.rightsConfirmed===true,
    outputFormat:"mp4",
    ...(sourceVideoAssetId?{sourceVideoAssetId}:{}),
    ...(startFrameAssetId?{startFrameAssetId}:{}),
    ...(referenceImageAssetIds.length?{referenceImageAssetIds}:{}),
    ...(referenceVideoAssetIds.length?{referenceVideoAssetIds}:{}),
    ...(previousInteractionId?{previousInteractionId}:{})
  };
  const requestHash=createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const input=deepFreeze({...normalized,requestHash});
  return deepFreeze({
    provider:"google",model:"gemini-omni-1.1-flash",operation,
    requestId,projectId:projectId.trim(),requestHash,input
  });
}

function createLumaWorkflowRequest({values,config,projectId,requestId}){
 const prompt=firstString(values.prompt,values.text,values.input,config.prompt);
 const requestedOperation=String(config.operation??"generate");
 if(!["generate","edit","reframe"].includes(requestedOperation))
  throw fail("Luma Workflow Canvas supports generation, video edit and video reframe; extension remains gated until source-generation ownership is verified.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
 const startFrameAssetId=firstString(values.startFrameAssetId,values["start-frame"],values.image,values.referenceImage,values.reference,
  config.startFrameAssetId,config.referenceAssetId);
 const endFrameAssetId=firstString(values.endFrameAssetId,values["end-frame"],config.endFrameAssetId);
 const sourceVideoAssetId=firstString(values.sourceVideoAssetId,values.sourceVideo,values.video,config.sourceVideoAssetId);
 const keyframeAssetIds=assetList(config.keyframeAssetIds??values.keyframeAssetIds,"Luma keyframe assets",64);
 const keyframeIndexes=config.keyframeIndexes??values.keyframeIndexes;
 const referenceAssetIds=assetList(config.referenceAssetIds??values.referenceAssetIds??values.references,"Luma generic references",1);
 if(referenceAssetIds.length)throw fail("Luma Ray 3.2 workflow quotes accept explicit private frame assets, not a generic reference list.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
 if(!prompt)throw fail("Luma Ray 3.2 requires a non-empty prompt.","PROMPT_REQUIRED");
 const durationSeconds=Number(config.durationSeconds??config.duration??5);
 if(!Number.isSafeInteger(durationSeconds))throw fail("Luma duration must be a whole number of seconds.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
 const aspectRatio=String(config.aspectRatio??"16:9");
 if(!["16:9","9:16","1:1","4:3","3:4","21:9"].includes(aspectRatio))throw fail("Luma Ray 3.2 aspect ratio is unsupported.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
 const resolution=String(config.resolution??"720p");
 if(!["360p","540p","720p","1080p"].includes(resolution))throw fail("Luma Ray 3.2 supports quoted 360p, 540p, 720p or 1080p output.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
 const editStrength=String(config.editStrength??"flex_2");
 if(requestedOperation==="generate"){
  if(sourceVideoAssetId)throw fail("Luma generation cannot include a source video; choose Edit or Reframe instead.","VIDEO_WORKFLOW_CLOUD_OPERATION_MISMATCH");
  if(![5,10].includes(durationSeconds))throw fail("Luma Ray 3.2 generation duration must be 5 or 10 seconds.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  if(durationSeconds===10&&(startFrameAssetId||endFrameAssetId))throw fail("Luma 10-second generation requires multi-keyframe mode instead of single start/end frame inputs.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  if(keyframeAssetIds.length){
   if(!Array.isArray(keyframeIndexes)||keyframeIndexes.length!==keyframeAssetIds.length)
    throw fail("Each Luma keyframe asset requires a matching output-frame index.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
   const maxFrame=durationSeconds*24;let previous=-1;
   for(const index of keyframeIndexes){
    if(!Number.isSafeInteger(index)||index<0||index>maxFrame||index<=previous)
     throw fail("Luma keyframe indexes must be unique, strictly increasing output-frame positions within the selected duration.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
    previous=index;
   }
   if(startFrameAssetId||endFrameAssetId)throw fail("Luma multi-keyframe mode cannot be combined with separate start/end frame inputs.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  }else if(keyframeIndexes!==undefined)throw fail("Luma keyframe indexes require matching keyframe assets.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
 }else{
  if(!sourceVideoAssetId)throw fail("Luma video edit and reframe require a private source-video asset from this project.","VIDEO_WORKFLOW_CLOUD_OPERATION_MISMATCH");
  if(startFrameAssetId||endFrameAssetId||keyframeAssetIds.length||keyframeIndexes!==undefined)
   throw fail("Luma source-video edit/reframe cannot be combined with generation frame anchors.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  if(requestedOperation==="edit"){
   if(durationSeconds<2||durationSeconds>18)throw fail("Luma video edit source clips must be 2–18 seconds.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
   if(!["adhere_1","adhere_2","adhere_3","flex_1","flex_2","flex_3","reimagine_1","reimagine_2","reimagine_3"].includes(editStrength))
    throw fail("Luma edit strength is unsupported.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  }else{
   if(durationSeconds<2||durationSeconds>10)throw fail("Luma reframe source duration must be 2–10 seconds.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
   if(resolution==="1080p")throw fail("Luma 1080p reframe is not enabled for this workflow until the provider account capability is verified.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  }
 }
 const sourcePosition=config.sourcePosition;
 if(sourcePosition!==undefined){
  if(requestedOperation!=="reframe"||!sourcePosition||typeof sourcePosition!=="object"||Array.isArray(sourcePosition)||
   !Number.isFinite(sourcePosition.x_norm)||sourcePosition.x_norm< -2||sourcePosition.x_norm>2||
   !Number.isFinite(sourcePosition.y_norm)||sourcePosition.y_norm< -2||sourcePosition.y_norm>2||
   !Number.isFinite(sourcePosition.w_norm)||sourcePosition.w_norm<=0||sourcePosition.w_norm>2||
   !Number.isFinite(sourcePosition.h_norm)||sourcePosition.h_norm<=0||sourcePosition.h_norm>2)
   throw fail("Luma sourcePosition is valid only for reframe and requires normalized coordinates with positive width and height.","VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
 }
 if((startFrameAssetId||endFrameAssetId||keyframeAssetIds.length||sourceVideoAssetId)&&config.rightsConfirmed!==true)
  throw fail("Explicit rights clearance is required for Luma source media.","MEDIA_RIGHTS_REQUIRED");
 const allAssetIds=[startFrameAssetId,endFrameAssetId,sourceVideoAssetId,...keyframeAssetIds].filter(Boolean);
 if(new Set(allAssetIds).size!==allAssetIds.length)throw fail("A Luma source asset cannot be assigned to more than one input role.","VIDEO_WORKFLOW_CLOUD_ASSET_ROLE_CONFLICT");
 const normalized={...normalizeVideoGenerationRequest({
  requestId,projectId:projectId.trim(),provider:"luma",model:"ray-3.2",
  prompt,operation:requestedOperation,durationSeconds,aspectRatio,resolution,audioMode:"none",
  ...(startFrameAssetId?{startFrameAssetId}:{}),
  ...(endFrameAssetId?{endFrameAssetId}:{})
 }),rightsConfirmed:config.rightsConfirmed===true,operation:requestedOperation};
 if(sourceVideoAssetId)normalized.sourceVideoAssetId=sourceVideoAssetId;
 if(requestedOperation==="edit")normalized.editStrength=editStrength;
 if(sourcePosition!==undefined)normalized.sourcePosition={...sourcePosition};
 if(keyframeAssetIds.length){
  normalized.keyframeAssetIds=keyframeAssetIds;
  normalized.keyframeIndexes=[...keyframeIndexes];
 }
 const operation=requestedOperation==="edit"?"video_edit":requestedOperation==="reframe"?"video_reframe":"generate";
 const requestHash=createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
 const input=deepFreeze({...normalized,requestHash});
 return deepFreeze({provider:"luma",model:"ray-3.2",operation,requestId,projectId:projectId.trim(),requestHash,input});
}

/**
 * Build the immutable, provider-bound input for a governed cloud video job.
 *
 * This is deliberately a contract builder, not an enqueue shortcut: callers
 * must still authenticate/authorize the project, resolve assets server-side,
 * obtain a quote, bind an explicit approval, reserve funds and use the durable
 * cloud enqueue/ledger. No provider or storage network calls occur here.
 *
 * Runway Model Router and Luma Ray 3.2 have dedicated governed quote/approval
 * adapters, private-source resolution, durable workers and task-level settlement.
 */
export function createVideoWorkflowCloudRequest({
  node, values = {}, projectId, requestId
} = {}) {
  if (!node || node.kind !== "video.generate") {
    throw fail("Only video.generate workflow nodes are supported by this cloud contract.", "VIDEO_WORKFLOW_CLOUD_NODE_UNSUPPORTED");
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw fail("Workflow node values must be an object.");
  }
  const config = node.config && typeof node.config === "object" && !Array.isArray(node.config)
    ? node.config : {};
  const provider = firstString(config.provider);
  const model = firstString(config.model);
  if(provider==="luma"&&model==="ray-3.2"){
    if(typeof projectId!=="string"||!projectId.trim()||projectId.length>160)throw fail("A saved project ID is required for Luma cloud video execution.","VIDEO_WORKFLOW_CLOUD_PROJECT_REQUIRED");
    if(typeof requestId!=="string"||!/^[A-Za-z0-9._:-]{1,160}$/.test(requestId))throw fail("A stable workflow request ID is required for idempotent cloud execution.","VIDEO_WORKFLOW_CLOUD_REQUEST_ID_REQUIRED");
    return createLumaWorkflowRequest({values,config,projectId,requestId});
  }
  if (provider === "google" && model === "gemini-omni-1.1-flash") {
    if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 160) {
      throw fail("A saved project ID is required for cloud video workflow execution.", "VIDEO_WORKFLOW_CLOUD_PROJECT_REQUIRED");
    }
    if (typeof requestId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) {
      throw fail("A stable workflow request ID is required for idempotent cloud execution.", "VIDEO_WORKFLOW_CLOUD_REQUEST_ID_REQUIRED");
    }
    return createGoogleOmniWorkflowRequest({node,values,config,projectId,requestId});
  }
  if (provider !== "runway" || model !== "model-router") {
    throw fail("Only explicit runway/model-router and google/gemini-omni-1.1-flash workflow adapters are supported.", "VIDEO_WORKFLOW_CLOUD_ADAPTER_UNAVAILABLE");
  }
  if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 160) {
    throw fail("A saved project ID is required for cloud video workflow execution.", "VIDEO_WORKFLOW_CLOUD_PROJECT_REQUIRED");
  }
  if (typeof requestId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(requestId)) {
    throw fail("A stable workflow request ID is required for idempotent cloud execution.", "VIDEO_WORKFLOW_CLOUD_REQUEST_ID_REQUIRED");
  }

  const prompt = firstString(values.prompt, values.text, values.input, config.prompt);
  const sourceVideoAssetId = firstString(
    values.sourceVideoAssetId, values.sourceVideo, values.video,
    config.sourceVideoAssetId
  );
  const startFrameAssetId = firstString(
    values.startFrameAssetId, values["start-frame"], values.image, values.referenceImage, values.reference, config.startFrameAssetId, config.referenceAssetId
  );
  const referenceAssetIds = assetList(
    config.referenceImageAssetIds ?? values.referenceImageAssetIds ?? values.references,
    "Reference images", 4
  );
  const referenceVideoAssetIds = assetList(
    config.referenceVideoAssetIds ?? values.referenceVideoAssetIds,
    "Reference videos", 1
  );
  const referenceAudioAssetIds = assetList(
    config.referenceAudioAssetIds ?? values.referenceAudioAssetIds ??
      (firstString(values.referenceAudioAssetId, config.referenceAudioAssetId)
        ? [firstString(values.referenceAudioAssetId, config.referenceAudioAssetId)] : []),
    "Reference audio", 1
  );

  const allAssetIds = [
    sourceVideoAssetId,
    startFrameAssetId,
    ...referenceAssetIds,
    ...referenceVideoAssetIds,
    ...referenceAudioAssetIds
  ].filter(Boolean);
  if (new Set(allAssetIds).size !== allAssetIds.length) {
    throw fail(
      "A workflow asset cannot be assigned to more than one source/reference role.",
      "VIDEO_WORKFLOW_CLOUD_ASSET_ROLE_CONFLICT"
    );
  }

  const derivedOperation = sourceVideoAssetId
    ? "video-to-video"
    : startFrameAssetId || referenceAssetIds.length
      ? "image-to-video"
      : "text-to-video";
  const requestedOperation = firstString(config.operation);
  if (requestedOperation && requestedOperation !== derivedOperation) {
    throw fail("Configured operation does not match the connected source assets.", "VIDEO_WORKFLOW_CLOUD_OPERATION_MISMATCH");
  }
  if (!prompt) throw fail("Video generation requires a non-empty prompt.", "PROMPT_REQUIRED");
  if (startFrameAssetId && referenceAssetIds.includes(startFrameAssetId)) {
    throw fail("The first-frame asset cannot also appear in the reference-image list.");
  }
  if (startFrameAssetId && referenceAssetIds.length > 3) {
    throw fail("Runway Model Router accepts at most four images including the first frame.");
  }
  if (derivedOperation !== "video-to-video" && referenceVideoAssetIds.length) {
    throw fail("Reference videos require a source video and the video-to-video operation.");
  }
  const audioMode = config.audioMode ?? "provider_default";
  if (audioMode === "reference" && referenceAudioAssetIds.length !== 1) {
    throw fail("Reference audio mode requires exactly one connected reference-audio asset.");
  }
  if (audioMode !== "reference" && referenceAudioAssetIds.length) {
    throw fail("Reference-audio assets require audioMode=reference.");
  }

  const normalized = normalizeVideoGenerationRequest({
    requestId,
    projectId: projectId.trim(),
    provider,
    model,
    operation: derivedOperation,
    prompt,
    negativePrompt: config.negativePrompt ?? values.negativePrompt,
    durationSeconds: Number(config.durationSeconds ?? config.duration ?? 5),
    aspectRatio: config.aspectRatio ?? "16:9",
    resolution: config.resolution ?? "provider_default",
    audioMode,
    referenceAssetIds,
    referenceVideoAssetIds,
    referenceAudioAssetIds,
    ...(sourceVideoAssetId ? { sourceVideoAssetId } : {}),
    ...(startFrameAssetId ? { startFrameAssetId } : {}),
    ...(config.seed != null ? { seed: config.seed } : {})
  });

  if (normalized.durationSeconds < 2 || normalized.durationSeconds > 30) {
    throw fail("Runway Model Router duration must be between 2 and 30 seconds.", "VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  }
  if (!["provider_default", "480p", "720p", "1080p", "4k"].includes(normalized.resolution)) {
    throw fail("Runway Model Router resolution is unsupported.", "VIDEO_WORKFLOW_CLOUD_CAPABILITY_UNSUPPORTED");
  }

  const requestHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const input = deepFreeze({ ...normalized, requestHash });
  return deepFreeze({
    provider,
    model,
    operation: derivedOperation,
    requestId,
    projectId: projectId.trim(),
    requestHash,
    input
  });
}
