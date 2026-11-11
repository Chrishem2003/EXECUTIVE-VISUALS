import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { submitRunwayVideoTask, getRunwayVideoTask, cancelRunwayVideoTask, downloadRunwayVideoTaskOutput } from "./runway-video-gateway.mjs";
import { submitFalVideoTask, getFalVideoTask, cancelFalVideoTask, downloadFalVideoTaskOutput } from "./fal-video-gateway.mjs";

const fail=(message,code)=>Object.assign(new Error(message),{code});
const TERMINAL=new Set(["FAILED","CANCELED","CANCELLED"]);
const PROVIDER_ADAPTERS=Object.freeze({fal:Object.freeze({submit:submitFalVideoTask,poll:getFalVideoTask,cancel:cancelFalVideoTask,download:downloadFalVideoTaskOutput})});
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{
 if(signal?.aborted)return reject(fail("Video generation job was cancelled.","JOB_CANCELLED"));
 const timer=setTimeout(done,ms);
 function done(){signal?.removeEventListener("abort",abort);resolve();}
 function abort(){clearTimeout(timer);signal?.removeEventListener("abort",abort);reject(fail("Video generation job was cancelled.","JOB_CANCELLED"));}
 signal?.addEventListener("abort",abort,{once:true});
});
function parseObject(value,label){
 if(value&&typeof value==="object"&&!Array.isArray(value))return value;
 try{const parsed=JSON.parse(String(value||"{}"));if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))return parsed;}catch{}
 throw fail(label+" must be a JSON object.","VIDEO_JOB_INVALID_INPUT");
}
function safeFileName(value){return String(value||"generated-shot").replace(/[^a-z0-9._-]+/gi,"-").replace(/^-+|-+$/g,"").slice(0,100)||"generated-shot";}

/**
 * Executes one already-approved shot using a durable task ledger.
 *
 * Repository contracts:
 * approvals.get(id) -> {id,ownerId,projectId,status,currency,budgetCeilingMicros,shots}
 * tasks.reserveSubmission({approvalId,shotIndex,ownerId,projectId,requestHash,currency,estimatedCostMicros})
 *   -> {id,state:"reserved"|"submitting"|"submission_unknown"|"submitted"|"processing"|"succeeded"|"failed",providerTaskId?}
 * tasks.markSubmitting(id), markSubmitted(id,{providerTaskId,model,estimatedCostCredits}),
 * markSubmissionUnknown(id,{code}), markProcessing(id,{providerStatus}),
 * markFailed(id,{code,message}), markSucceeded(id,{providerTaskId,asset})
 *
 * reserveSubmission MUST atomically enforce owner/project scope, approval state,
 * unique approval+shot identity, and aggregate reserved/committed budget <= ceiling.
 */
export function createCloudVideoGenerationExecutor({
 approvals,tasks,mediaIO,
 submitTask=submitRunwayVideoTask,getTask=getRunwayVideoTask,downloadOutput=downloadRunwayVideoTaskOutput,
 providerAdapters=PROVIDER_ADAPTERS,sleepImpl=sleep,pollIntervalMs=5000,maxOutputBytes=250*1024*1024,tempRoot=tmpdir()
}={}){
 if(typeof approvals?.get!=="function"||typeof tasks?.reserveSubmission!=="function"||
    typeof tasks?.markSubmitting!=="function"||typeof tasks?.markSubmitted!=="function"||
    typeof tasks?.markSubmissionUnknown!=="function"||typeof tasks?.markProcessing!=="function"||
    typeof tasks?.markFailed!=="function"||typeof tasks?.markSucceeded!=="function"||
    typeof tasks?.markCancellationRequested!=="function"||typeof tasks?.markCancelled!=="function"||
    typeof mediaIO?.publish!=="function")throw new Error("Cloud video generation requires approval, task-ledger and private media repositories.");
 if(typeof submitTask!=="function"||typeof getTask!=="function"||typeof downloadOutput!=="function")throw new Error("Cloud video generation requires provider task adapters.");
 if(!Number.isInteger(pollIntervalMs)||pollIntervalMs<5000||pollIntervalMs>60000)throw new Error("Provider polling interval must be between 5 and 60 seconds.");
 if(!Number.isInteger(maxOutputBytes)||maxOutputBytes<1024||maxOutputBytes>1024*1024*1024)throw new Error("Generated output size limit is invalid.");

 return async function execute({job,signal,onProgress=()=>{}}={}){
  if(!job||typeof job.id!=="string"||typeof job.owner_id!=="string"||!job.project_id)throw fail("Video generation job is missing its database-scoped owner or project.","VIDEO_JOB_SCOPE_INVALID");
  if(typeof job.lease_token!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(job.lease_token)||
     typeof job.lease_owner!=="string"||!job.lease_owner)throw fail("Video generation job is missing its worker fencing lease.","CLOUD_WORKER_LEASE_LOST");
  const leaseContext=Object.freeze({jobId:job.id,workerId:job.lease_owner,leaseToken:job.lease_token});
  const assertCurrentLease=async()=>{if(await assertLease()!==true)throw fail("Video generation worker lease was lost.","CLOUD_WORKER_LEASE_LOST");return true;};
  const ensureLease=async()=>{if(signal?.aborted)throw fail("Video generation job was cancelled.","JOB_CANCELLED");await assertCurrentLease();};
  await ensureLease();
  const input=parseObject(job.input??job.input_json,"Video generation job input");
  const approvalId=String(input.approvalId||"");
  const shotIndex=Number(input.shotIndex);
  if(!approvalId||!Number.isInteger(shotIndex)||shotIndex<0)throw fail("Video generation job must reference an approval and shot index.","VIDEO_JOB_INVALID_INPUT");
  const approval=await approvals.get(approvalId,{ownerId:job.owner_id,projectId:job.project_id});
  if(!approval||approval.id!==approvalId||approval.ownerId!==job.owner_id||approval.projectId!==job.project_id)
   throw fail("Approved production record is not accessible to this job owner and project.","VIDEO_APPROVAL_SCOPE_INVALID");
  if(!["approved_pending_submission","processing"].includes(approval.status)||!Array.isArray(approval.shots)||shotIndex>=approval.shots.length)
   throw fail("A valid approved shot snapshot is required before generation.","VIDEO_APPROVAL_NOT_EXECUTABLE");
  const shot=parseObject(approval.shots[shotIndex],"Approved shot");
  const provider=String(shot.provider||"").toLowerCase();
  const adapter=provider==="runway"?{submit:submitTask,poll:getTask,cancel:cancelRunwayVideoTask,download:downloadOutput}:providerAdapters?.[provider];
  if(!adapter||typeof adapter.submit!=="function"||typeof adapter.poll!=="function"||typeof adapter.download!=="function")throw fail("The approved provider has no verified durable worker adapter.","VIDEO_PROVIDER_UNSUPPORTED");
  if(typeof shot.prompt!=="string"||!shot.prompt.trim()||!shot.model)throw fail("Approved shot is missing its provider model or prompt.","VIDEO_JOB_INVALID_INPUT");
  const currency=String(approval.currency||"");
  const estimatedCostMicros=Number(shot.estimatedCostMicros);
  if(!currency||!Number.isSafeInteger(estimatedCostMicros)||estimatedCostMicros<0||
     !Number.isSafeInteger(Number(approval.budgetCeilingMicros))||Number(approval.budgetCeilingMicros)<0)
   throw fail("Approved shot is missing a verified currency, quote or budget ceiling.","VIDEO_APPROVAL_BUDGET_INVALID");

  // The atomic reservation is the final budget/duplicate gate. It must be
  // implemented against the same durable ledger as the approval record.
  let task=await tasks.reserveSubmission({...leaseContext,approvalId,shotIndex,ownerId:job.owner_id,projectId:job.project_id,requestHash:String(approval.requestHash||""),currency,estimatedCostMicros});
  if(!task||!task.id)throw fail("Durable task reservation was not confirmed.","VIDEO_TASK_RESERVATION_FAILED");
  let providerTaskId=task.providerTaskId||null;
  const cancelTask=async()=>{
   await assertCurrentLease();\n   if(task.state!=="cancel_requested")await tasks.markCancellationRequested(task.id,{providerStatus:"CANCEL_REQUESTED"},leaseContext);
   if(providerTaskId){
    if(typeof adapter.cancel!=="function")throw fail("The selected provider adapter cannot confirm remote cancellation; the task remains cancellation-pending.","VIDEO_TASK_CANCELLATION_PENDING");
    await assertCurrentLease();\n    const cancelled=await adapter.cancel({taskId:providerTaskId,model:shot.model});
    if(cancelled?.status==="CANCELLATION_REQUESTED"){
     await assertCurrentLease();\n     await tasks.markCancellationRequested(task.id,{providerStatus:"CANCELLATION_REQUESTED"},leaseContext);
     throw fail("The provider accepted cancellation but has not confirmed termination. The durable task remains pending reconciliation.","VIDEO_TASK_CANCELLATION_PENDING");
    }
    if(!["OK","CANCELLED","NOT_FOUND","ALREADY_COMPLETED"].includes(cancelled?.status))throw fail("The provider returned an unrecognized cancellation result. The durable task remains pending reconciliation.","VIDEO_TASK_CANCELLATION_PENDING");
    await assertCurrentLease();\n    await tasks.markCancelled(task.id,{providerStatus:cancelled.status},leaseContext);
   }else{
    await assertCurrentLease();\n    await tasks.markCancelled(task.id,{providerStatus:"NOT_SUBMITTED"},leaseContext);
   }
   throw fail("Video generation job was cancelled.","JOB_CANCELLED");
  };
  if(task.state==="cancelled")throw fail("This approved shot was already cancelled.","VIDEO_TASK_ALREADY_CANCELLED");
  if(task.state==="cancel_requested"){
   if(!providerTaskId){await assertCurrentLease();await tasks.markCancelled(task.id,{providerStatus:"NOT_SUBMITTED"},leaseContext);throw fail("Video generation job was cancelled.","JOB_CANCELLED");}
   await assertCurrentLease();\n   const current=await adapter.poll({taskId:providerTaskId,model:shot.model});
   if(TERMINAL.has(current.status)||current.status==="SUCCEEDED"){
    await assertCurrentLease();\n    await tasks.markCancelled(task.id,{providerStatus:current.status},leaseContext);
    throw fail("Video generation job was cancelled.","JOB_CANCELLED");
   }
   await cancelTask();
  }
  if(signal?.aborted)await cancelTask();
  if(task.state==="succeeded"){
   if(!task.outputAssetId)throw fail("A completed task is missing its published asset identity.","VIDEO_TASK_LEDGER_CORRUPT");
   return {approvalId,shotIndex,provider,model:shot.model,providerTaskId:task.providerTaskId,outputAsset:{id:task.outputAssetId},replayed:true};
  }
  if(task.state==="failed")throw fail("This approved shot already failed. Create a new approval to authorize another paid attempt.","VIDEO_TASK_ALREADY_FAILED");
  if(!providerTaskId){
   if(["submitting","submission_unknown"].includes(task.state))
    throw fail("A prior provider submission has an unknown outcome. Reconcile it before any new POST.","VIDEO_GATEWAY_SUBMISSION_UNKNOWN");
   if(task.state!=="reserved")throw fail("Task ledger is not in a safe state for provider submission.","VIDEO_TASK_STATE_CONFLICT");
   await ensureLease();\n   await tasks.markSubmitting(task.id,leaseContext);
   onProgress(5);
   let submitted;
   try{await ensureLease();submitted=await adapter.submit({model:shot.model,prompt:shot.prompt,durationSeconds:shot.durationSeconds,duration:shot.durationSeconds,aspectRatio:shot.aspectRatio,resolution:shot.resolution,referenceImageDataUrl:shot.referenceImageDataUrl||"",signal});}
   catch(error){
    if(error?.code==="VIDEO_GATEWAY_SUBMISSION_UNKNOWN"||["VIDEO_GATEWAY_TIMEOUT","VIDEO_GATEWAY_UNAVAILABLE","VIDEO_GATEWAY_SERVER_ERROR"].includes(error?.code)){
     await assertCurrentLease();\n     await tasks.markSubmissionUnknown(task.id,{code:"VIDEO_GATEWAY_SUBMISSION_UNKNOWN"},leaseContext);
     throw fail("Provider submission may have been accepted. The task is held for reconciliation; it will not be submitted again automatically.","VIDEO_GATEWAY_SUBMISSION_UNKNOWN");
    }
    await assertCurrentLease();\n    await tasks.markFailed(task.id,{code:error?.code||"VIDEO_PROVIDER_REJECTED",message:String(error?.message||"Provider rejected generation.").slice(0,300)},leaseContext);
    throw error;
   }
   providerTaskId=String(submitted?.taskId||"");
   if(!providerTaskId){await assertCurrentLease();await tasks.markSubmissionUnknown(task.id,{code:"VIDEO_PROVIDER_TASK_ID_MISSING"},leaseContext);throw fail("Provider accepted a request without a usable task ID. Reconciliation is required.","VIDEO_GATEWAY_SUBMISSION_UNKNOWN");}
   try{await assertCurrentLease();await tasks.markSubmitted(task.id,{providerTaskId,provider,model:shot.model,estimatedCostCredits:submitted.estimatedCostCredits??null},leaseContext);}
   catch(error){await tasks.markSubmissionUnknown(task.id,{code:"VIDEO_TASK_PERSISTENCE_FAILED"},leaseContext).catch(()=>{});throw fail("Provider task was created but its ID could not be durably recorded. Reconcile before retrying.","VIDEO_GATEWAY_SUBMISSION_UNKNOWN");}
   if(signal?.aborted)await cancelTask();
  }

  let pollDelay=pollIntervalMs;
  while(true){
   if(signal?.aborted)await cancelTask();
   let current;
   try{await ensureLease();current=await adapter.poll({taskId:providerTaskId,model:shot.model});}
   catch(error){
    if(["VIDEO_GATEWAY_TIMEOUT","VIDEO_GATEWAY_UNAVAILABLE","VIDEO_GATEWAY_SERVER_ERROR","VIDEO_GATEWAY_RATE_LIMITED"].includes(error?.code)){
     try{await sleepImpl(pollDelay,signal);}catch(sleepError){if(signal?.aborted)await cancelTask();throw sleepError;}pollDelay=Math.min(60000,Math.ceil(pollDelay*1.7));continue;
    }
    throw error;
   }
   if(current.status==="SUCCEEDED")break;
   if(current.status==="CANCELED"||current.status==="CANCELLED"){
    await assertCurrentLease();\n    await tasks.markCancelled(task.id,{providerStatus:current.status},leaseContext);
    throw fail("Provider task was cancelled.","JOB_CANCELLED");
   }
   if(current.status==="FAILED"){
    await assertCurrentLease();\n    await tasks.markFailed(task.id,{code:"VIDEO_PROVIDER_TASK_FAILED",message:String(current.error?.message||current.error||"Provider task failed.").slice(0,300)},leaseContext);
    throw fail("Provider generation failed. Review the task record before authorizing another attempt.","VIDEO_PROVIDER_TASK_FAILED");
   }
   if(!["PENDING","THROTTLED","RUNNING"].includes(current.status))throw fail("Provider returned an unknown task state.","VIDEO_PROVIDER_STATE_INVALID");
   await ensureLease();\n   await tasks.markProcessing(task.id,{providerStatus:current.status},leaseContext);
   onProgress(current.status==="PENDING"||current.status==="THROTTLED"?15:45);
   try{await sleepImpl(pollDelay,signal);}catch(sleepError){if(signal?.aborted)await cancelTask();throw sleepError;}
   pollDelay=Math.min(60000,Math.ceil(pollDelay*1.25));
  }
  await ensureLease();\n  const completed=await adapter.poll({taskId:providerTaskId,model:shot.model});
  if(completed.status!=="SUCCEEDED"||!completed.outputUrl)throw fail("Completed provider task did not contain a verified output URL.","VIDEO_PROVIDER_OUTPUT_MISSING");
  if(signal?.aborted)await cancelTask();
  await ensureLease();\n  const bytes=await adapter.download({outputUrl:completed.outputUrl,signal});
  if(!Buffer.isBuffer(bytes)||bytes.length<12||bytes.length>maxOutputBytes||bytes.toString("ascii",4,8)!=="ftyp")
   throw fail("Generated video failed bounded MP4 validation.","VIDEO_OUTPUT_INVALID");
  if(signal?.aborted)await cancelTask();
  const directory=await mkdtemp(join(tempRoot,"ev-video-shot-"));
  try{
   const filePath=join(directory,randomUUID()+".mp4");
   await writeFile(filePath,bytes,{flag:"wx",mode:0o600});
   await ensureLease();\n   const asset=await mediaIO.publish({
    ownerId:job.owner_id,projectId:job.project_id,filename:safeFileName(shot.name||("shot-"+(shotIndex+1)))+".mp4",
    mediaType:"video/mp4",path:filePath,derivativeOf:null,
    metadata:{operation:"video.generate",provider,model:shot.model,providerTaskId,approvalId,shotIndex,approvedRequestHash:approval.requestHash||null},
    publicationKey:job.id+":video-shot:"+shotIndex+":v1",\n    assertLease:assertCurrentLease,signal,leaseContext
   });
   await ensureLease();\n   await tasks.markSucceeded(task.id,{providerTaskId,asset},leaseContext);
   onProgress(100);
   return {approvalId,shotIndex,provider,model:shot.model,providerTaskId,outputAsset:asset};
  }finally{await rm(directory,{recursive:true,force:true}).catch(()=>{});}
 };
}
