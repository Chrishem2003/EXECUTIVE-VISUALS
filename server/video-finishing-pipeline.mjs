import { createHash } from "node:crypto";

const STEP_KINDS=new Set(["transform","upscale","frame_rate","hdr","audio_finish","transcode"]);
const SHA256=/^[a-f0-9]{64}$/i;
const plain=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const stable=value=>Array.isArray(value)?"["+value.map(stable).join(",")+"]":plain(value)?"{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+stable(value[key])).join(",")+"}":JSON.stringify(value);
const hash=value=>createHash("sha256").update(value).digest("hex");
function deepFreeze(value){
 if(value&&typeof value==="object"&&!Object.isFrozen(value)){
  Object.freeze(value);
  for(const child of Object.values(value))deepFreeze(child);
 }
 return value;
}
const fail=(message,code)=>Object.assign(new Error(message),{code});

function validatePlan(plan,approval){
 if(!plain(plan))throw fail("Video pipeline plan must be an object.","VIDEO_PIPELINE_INVALID_PLAN");
 if(typeof plan.pipelineId!=="string"||!plan.pipelineId.trim()||plan.pipelineId.length>160)throw fail("Video pipeline ID is required.","VIDEO_PIPELINE_INVALID_PLAN");
 const source=plan.sourceAsset;
 if(!plain(source)||typeof source.id!=="string"||!source.id.trim()||typeof source.mediaType!=="string"||!source.mediaType.startsWith("video/")||!SHA256.test(source.sha256||""))
  throw fail("A source video asset ID, media type and SHA-256 are required.","VIDEO_PIPELINE_SOURCE_INVALID");
 if(!Array.isArray(plan.steps)||plan.steps.length<1||plan.steps.length>12)throw fail("Video pipeline must contain between 1 and 12 steps.","VIDEO_PIPELINE_INVALID_PLAN");
 const ids=new Set();let total=0;let remote=false;
 const steps=plan.steps.map(step=>{
  if(!plain(step)||typeof step.id!=="string"||!step.id.trim()||step.id.length>120||ids.has(step.id))throw fail("Pipeline step IDs must be unique non-empty strings.","VIDEO_PIPELINE_INVALID_STEP");
  ids.add(step.id);
  if(!STEP_KINDS.has(step.kind)||typeof step.adapter!=="string"||!step.adapter.trim()||typeof step.capability!=="string"||!step.capability.trim())throw fail("Pipeline step kind, adapter and capability are required.","VIDEO_PIPELINE_INVALID_STEP");
  if(step.estimatedCostMicros==null||!Number.isSafeInteger(step.estimatedCostMicros)||step.estimatedCostMicros<0)throw fail("Every pipeline step must have a known non-negative cost estimate before execution.","VIDEO_PIPELINE_COST_UNKNOWN");
  if(!plain(step.config??{}))throw fail("Pipeline step config must be an object.","VIDEO_PIPELINE_INVALID_STEP");
  let config;
  try{config=JSON.parse(JSON.stringify(step.config??{}));}catch{throw fail("Pipeline step config must contain only JSON-safe values.","VIDEO_PIPELINE_INVALID_STEP");}
  if(JSON.stringify(config).length>16000)throw fail("Pipeline step config exceeds 16 KB.","VIDEO_PIPELINE_INVALID_STEP");
  if(typeof step.remote!=="boolean")throw fail("Pipeline step must declare whether its adapter is remote.","VIDEO_PIPELINE_INVALID_STEP");
  remote ||= step.remote;total+=step.estimatedCostMicros;
  if(!Number.isSafeInteger(total))throw fail("Pipeline cost total exceeds the supported range.","VIDEO_PIPELINE_COST_INVALID");
  return Object.freeze({...step,config:deepFreeze(config)});
 });
 if(remote){
  if(approval?.remoteExecutionApproved!==true||typeof approval.approvalId!=="string"||!approval.approvalId.trim())throw fail("Explicit remote-execution approval is required before any pipeline step runs.","VIDEO_PIPELINE_APPROVAL_REQUIRED");
  if(!Number.isSafeInteger(approval.approvedBudgetMicros)||approval.approvedBudgetMicros<total)throw fail("Approved budget does not cover the full pipeline estimate.","VIDEO_PIPELINE_BUDGET_EXCEEDED");
 }
 return {pipelineId:plan.pipelineId,sourceAsset:Object.freeze({...source}),steps,totalEstimatedCostMicros:total,approvalId:approval?.approvalId||null};
}

function validateOutput(output,sourceAsset){
 if(!plain(output)||typeof output.id!=="string"||!output.id.trim()||typeof output.mediaType!=="string"||!output.mediaType.startsWith("video/")||!SHA256.test(output.sha256||"")||output.derivativeOf!==sourceAsset.id)
  throw fail("Pipeline adapter returned an invalid derivative asset receipt.","VIDEO_PIPELINE_OUTPUT_INVALID");
 return Object.freeze({...output,sha256:output.sha256.toLowerCase()});
}

/**
 * Executes an approved, checkpointed sequence of video operations.
 * Provider calls are injected; this module never chooses a vendor, spends money,
 * downloads a URL, or bypasses the asset repository.
 */
export function createVideoFinishingPipeline({resolveAdapter,executeStep,checkpoints}={}){
 if(typeof resolveAdapter!=="function"||typeof executeStep!=="function")throw new Error("Video pipeline requires adapter resolution and execution functions.");
 if(!checkpoints||typeof checkpoints.get!=="function"||typeof checkpoints.save!=="function")throw new Error("Video pipeline requires durable checkpoint storage.");
 return Object.freeze({
  async run(plan,approval={}, {signal,onProgress=()=>{}}={}){
   const normalized=validatePlan(plan,approval);
   let current=normalized.sourceAsset;
   const results=[];
   for(let index=0;index<normalized.steps.length;index++){
    if(signal?.aborted)throw fail("Video pipeline was cancelled.","VIDEO_PIPELINE_CANCELLED");
    const step=normalized.steps[index];
    const adapter=await resolveAdapter(step.adapter);
    if(!adapter||adapter.status!=="ready"||!Array.isArray(adapter.capabilities)||!adapter.capabilities.includes(step.capability)||Boolean(adapter.remote)!==step.remote)
     throw fail("The selected adapter is not ready or does not declare the requested capability.","VIDEO_PIPELINE_ADAPTER_NOT_READY");
    const inputAsset=current;
    const idempotencyKey=hash([normalized.pipelineId,step.id,inputAsset.id,inputAsset.sha256,stable(step.config)].join("|"));
    const prior=await checkpoints.get(normalized.pipelineId,step.id);
    if(prior){
     if(prior.status!=="succeeded"||prior.idempotencyKey!==idempotencyKey)throw fail("A pipeline checkpoint conflicts with the current source or step configuration.","VIDEO_PIPELINE_CHECKPOINT_CONFLICT");
     current=validateOutput(prior.outputAsset,inputAsset);
     results.push({stepId:step.id,status:"reused",asset:current,idempotencyKey});
     onProgress({stepId:step.id,index:index+1,total:normalized.steps.length,status:"reused"});
     continue;
    }
    try{
     const raw=await executeStep({adapter,step,sourceAsset:inputAsset,idempotencyKey,approvalId:normalized.approvalId,signal});
     const output=validateOutput(raw,inputAsset);
     const checkpoint={pipelineId:normalized.pipelineId,stepId:step.id,status:"succeeded",inputAssetId:inputAsset.id,inputSha256:inputAsset.sha256,idempotencyKey,outputAsset:output,approvalId:normalized.approvalId};
     await checkpoints.save(checkpoint);
     current=output;
     results.push({stepId:step.id,status:"completed",asset:output,idempotencyKey});
     onProgress({stepId:step.id,index:index+1,total:normalized.steps.length,status:"completed"});
    }catch(error){
     if(error?.code==="VIDEO_PIPELINE_OUTPUT_INVALID")throw error;
     throw error;
    }
   }
   return Object.freeze({pipelineId:normalized.pipelineId,status:"completed",sourceAssetId:normalized.sourceAsset.id,outputAsset:current,totalEstimatedCostMicros:normalized.totalEstimatedCostMicros,approvalId:normalized.approvalId,steps:results});
  }
 });
}
