const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(message,code)=>Object.assign(new Error(message),{code});
function parseSnapshot(value){
 let snapshot=value;
 if(typeof snapshot==="string"){try{snapshot=JSON.parse(snapshot);}catch{throw fail("Saved approval snapshot is invalid JSON.","VIDEO_APPROVAL_SNAPSHOT_INVALID");}}
 if(!snapshot||typeof snapshot!=="object"||Array.isArray(snapshot)||!Array.isArray(snapshot.shots)||snapshot.shots.length<1||snapshot.shots.length>100)
  throw fail("Saved approval snapshot does not contain a valid shot list.","VIDEO_APPROVAL_SNAPSHOT_INVALID");
 return snapshot;
}
function safeError(error){
 const code=String(error?.code||"CLOUD_VIDEO_DISPATCH_FAILED").slice(0,80);
 const known=new Set(["VIDEO_APPROVAL_IDEMPOTENCY_CONFLICT","VIDEO_APPROVAL_PROJECT_SCOPE_INVALID","VIDEO_APPROVAL_INVALID","VIDEO_APPROVAL_SNAPSHOT_INVALID","VIDEO_APPROVAL_NOT_EXECUTABLE","VIDEO_JOB_IDEMPOTENCY_CONFLICT","VIDEO_REPOSITORY_TIMEOUT"]);
 return {code:known.has(code)?code:"CLOUD_VIDEO_DISPATCH_FAILED",message:known.has(code)?String(error?.message||"Cloud generation dispatch failed.").slice(0,300):"Cloud generation dispatch could not be confirmed. Retry the same approval safely."};
}
/**
 * Mirrors a locally budget-approved snapshot into the cloud ledger and queues
 * its shots. It never calls a model provider; the separately gated worker does.
 */
export function createCloudVideoGenerationDispatch({db,repositories,audit=()=>{},canWriteProject}={}){
 if(typeof db?.prepare!=="function"||typeof repositories?.approvals?.register!=="function"||typeof repositories?.approvals?.enqueue!=="function"||typeof canWriteProject!=="function")
  throw new Error("Cloud video dispatch requires the local approval database, cloud repositories and project authorization.");
 return Object.freeze({
  async submit({approvalId,ownerId}={}){
   if(typeof approvalId!=="string"||!UUID.test(approvalId)||typeof ownerId!=="string"||!UUID.test(ownerId))
    return {status:400,body:{error:{code:"VIDEO_APPROVAL_ID_INVALID",message:"A valid approval and authenticated account are required."}}};
   const local=db.prepare("SELECT * FROM video_generation_approvals WHERE id=? AND owner_id=?").get(approvalId,ownerId);
   if(!local)return {status:404,body:{error:{code:"VIDEO_APPROVAL_NOT_FOUND",message:"Production approval not found."}}};
   if(!local.project_id)return {status:422,body:{error:{code:"VIDEO_APPROVAL_PROJECT_REQUIRED",message:"Cloud generation requires an approved production attached to a cloud project."}}};
   if(!canWriteProject(ownerId,local.project_id))return {status:404,body:{error:{code:"PROJECT_NOT_FOUND",message:"Project not found or editor access required."}}};
   const replay=local.status==="consumed";
   if(!replay&&local.status!=="approved_pending_submission")
    return {status:409,body:{error:{code:"VIDEO_APPROVAL_NOT_EXECUTABLE",message:"Only a pending, budget-approved production can be submitted."}}};
   let snapshot;
   try{snapshot=parseSnapshot(local.snapshot_json);}catch(error){return {status:409,body:{error:safeError(error)}};}
   if(typeof local.idempotency_key!=="string"||local.idempotency_key.length<8||! /^[a-f0-9]{64}$/i.test(String(local.request_hash||"")))
    return {status:409,body:{error:{code:"VIDEO_APPROVAL_SNAPSHOT_INVALID",message:"The saved approval is missing its durable idempotency or request hash."}}};
   try{
    const cloud=await repositories.approvals.register({
     id:local.id,ownerId,projectId:local.project_id,idempotencyKey:local.idempotency_key,
     requestHash:local.request_hash,snapshotJson:snapshot,currency:local.currency,
     quotedAmountMicros:Number(local.quoted_amount_micros),budgetCeilingMicros:Number(local.budget_ceiling_micros)
    });
    if(!cloud||cloud.id!==local.id||cloud.ownerId!==ownerId||cloud.projectId!==local.project_id||
       cloud.requestHash!==local.request_hash||cloud.currency!==local.currency||
       cloud.quotedAmountMicros!==Number(local.quoted_amount_micros)||
       cloud.budgetCeilingMicros!==Number(local.budget_ceiling_micros)||
       !["approved_pending_submission","processing"].includes(cloud.status))
     throw fail("Cloud approval receipt does not match the locally approved snapshot.","VIDEO_APPROVAL_SNAPSHOT_MISMATCH");
    const jobs=await repositories.approvals.enqueue(local.id,ownerId);
    if(!Array.isArray(jobs)||jobs.length!==snapshot.shots.length||
       jobs.some((job,index)=>!job||job.shotIndex!==index||!UUID.test(String(job.jobId||""))))
     throw fail("Cloud queue receipt did not confirm every approved shot.","VIDEO_QUEUE_RECEIPT_INVALID");
    const changed=db.prepare("UPDATE video_generation_approvals SET status='consumed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND owner_id=? AND status='approved_pending_submission'").run(local.id,ownerId);
    if(changed.changes===1)audit(ownerId,"video_generation.cloud_jobs_enqueued","video_generation_approval",local.id,{jobCount:jobs.length,jobIds:jobs.map(job=>job.jobId),requestHash:local.request_hash},local.project_id);
    return {status:replay?200:202,body:{approval:{id:local.id,status:"processing",requestHash:local.request_hash,shotCount:snapshot.shots.length},jobs,idempotentReplay:replay||changed.changes===0,providerRequestsSubmitted:false,message:"Approved shots are queued. Provider execution occurs only in the separately enabled cloud worker."}};
   }catch(error){
    const detail=safeError(error);
    const status=detail.code==="VIDEO_APPROVAL_IDEMPOTENCY_CONFLICT"||detail.code==="VIDEO_APPROVAL_PROJECT_SCOPE_INVALID"?409:detail.code==="VIDEO_REPOSITORY_TIMEOUT"?503:502;
    return {status,body:{error:detail,providerRequestsSubmitted:false}};
   }
  }
 });
}
