const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/i;
const fail=(message,code)=>Object.assign(new Error(message),{code});

function parseSnapshot(value){
  let snapshot=value;
  if(typeof snapshot==="string"){
    try{snapshot=JSON.parse(snapshot);}
    catch{throw fail("Saved production approval is invalid JSON.","VIDEO_APPROVAL_SNAPSHOT_INVALID");}
  }
  if(!snapshot||typeof snapshot!=="object"||Array.isArray(snapshot)||
     !Array.isArray(snapshot.shots)||snapshot.shots.length<1||snapshot.shots.length>12){
    throw fail("Saved production approval must contain between 1 and 12 shots.","VIDEO_APPROVAL_SNAPSHOT_INVALID");
  }
  return snapshot;
}

function safeError(error){
  const code=String(error?.code||"NEON_STAGING_DISPATCH_FAILED").slice(0,80);
  const known=new Set([
    "VIDEO_APPROVAL_IDEMPOTENCY_CONFLICT","VIDEO_APPROVAL_PROJECT_SCOPE_INVALID",
    "VIDEO_APPROVAL_INVALID","VIDEO_APPROVAL_SNAPSHOT_INVALID",
    "VIDEO_APPROVAL_SNAPSHOT_MISMATCH","VIDEO_APPROVAL_NOT_EXECUTABLE",
    "VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID","VIDEO_APPROVAL_NOT_FOUND",
    "VIDEO_APPROVAL_PERSISTENCE_FAILED","VIDEO_QUEUE_RECEIPT_INVALID",
    "VIDEO_REPOSITORY_TIMEOUT","VIDEO_TASK_RESERVATION_FAILED"
  ]);
  return {
    code:known.has(code)?code:"NEON_STAGING_DISPATCH_FAILED",
    message:known.has(code)?String(error?.message||"Neon staging dispatch failed.").slice(0,300):
      "Neon staging dispatch could not be confirmed. Retry using the same approval."
  };
}

/**
 * Application boundary for moving a locally approved production into the
 * isolated Neon staging ledger. It never calls a provider. The host supplies
 * authenticated identity/project authorization and a runtime whose customer
 * credit quote policy was configured server-side.
 */
export function createNeonStagingApplicationDispatch({
  db,runtime,canWriteProject,audit=()=>{}
}={}){
  if(typeof db?.prepare!=="function")throw new Error("Neon staging dispatch requires the application's approval database.");
  if(runtime?.backend!=="neon-postgres"||runtime?.branch!=="executive-visuals-staging"||
     typeof runtime?.videoApprovals?.approvals?.register!=="function"||
     typeof runtime?.videoApprovals?.approvals?.enqueue!=="function"){
    throw new Error("Neon staging dispatch requires a ready, approval-enabled executive-visuals-staging runtime.");
  }
  if(typeof canWriteProject!=="function")throw new Error("Neon staging dispatch requires the authenticated project authorization boundary.");

  async function submit({approvalId,ownerId}={}){
    if(!UUID.test(String(approvalId||""))||!UUID.test(String(ownerId||""))){
      return {status:400,body:{error:{code:"VIDEO_APPROVAL_ID_INVALID",message:"A valid approval and authenticated account are required."}}};
    }
    const local=db.prepare("SELECT * FROM video_generation_approvals WHERE id=? AND owner_id=?").get(approvalId,ownerId);
    if(!local)return {status:404,body:{error:{code:"VIDEO_APPROVAL_NOT_FOUND",message:"Production approval not found."}}};
    if(!local.project_id)return {status:422,body:{error:{code:"VIDEO_APPROVAL_PROJECT_REQUIRED",message:"Neon staging generation requires an approved production attached to a project."}}};
    let allowed=false;
    try{allowed=canWriteProject(ownerId,local.project_id)===true;}catch{}
    if(!allowed)return {status:404,body:{error:{code:"PROJECT_NOT_FOUND",message:"Project not found or editor access required."}}};
    const replay=local.status==="consumed";
    if(!replay&&local.status!=="approved_pending_submission"){
      return {status:409,body:{error:{code:"VIDEO_APPROVAL_NOT_EXECUTABLE",message:"Only a pending, budget-approved production can be submitted."}}};
    }
    if(typeof local.idempotency_key!=="string"||local.idempotency_key.length<8||local.idempotency_key.length>200||
       !HASH.test(String(local.request_hash||""))||
       !/^[A-Z]{3}$/.test(String(local.currency||""))||
       !Number.isSafeInteger(Number(local.quoted_amount_micros))||
       !Number.isSafeInteger(Number(local.budget_ceiling_micros))){
      return {status:409,body:{error:{code:"VIDEO_APPROVAL_SNAPSHOT_INVALID",message:"The saved approval is missing its verified price or durable idempotency fields."}}};
    }
    let snapshot;
    try{
      snapshot=parseSnapshot(local.snapshot_json);
      const total=snapshot.shots.reduce((sum,shot)=>sum+Number(shot?.estimatedCostMicros||0),0);
      if(snapshot.shots.some(shot=>!shot||typeof shot.provider!=="string"||typeof shot.model!=="string"||
         !Number.isSafeInteger(shot.estimatedCostMicros)||shot.estimatedCostMicros<1)||
         total!==Number(local.quoted_amount_micros)){
        throw fail("Saved shot prices do not match the approved production quote.","VIDEO_APPROVAL_SNAPSHOT_MISMATCH");
      }
    }catch(error){return {status:409,body:{error:safeError(error)}};}
    try{
      const cloud=await runtime.videoApprovals.approvals.register({
        id:local.id,ownerId,projectId:local.project_id,idempotencyKey:local.idempotency_key,
        requestHash:local.request_hash,snapshotJson:snapshot,currency:local.currency,
        quotedAmountMicros:Number(local.quoted_amount_micros),
        budgetCeilingMicros:Number(local.budget_ceiling_micros)
      });
      if(!cloud||cloud.id!==local.id||cloud.ownerId!==ownerId||cloud.projectId!==local.project_id||
         cloud.requestHash!==local.request_hash||cloud.currency!==local.currency||
         cloud.quotedAmountMicros!==Number(local.quoted_amount_micros)||
         cloud.budgetCeilingMicros!==Number(local.budget_ceiling_micros)||
         !["approved_pending_submission","processing"].includes(cloud.status)){
        throw fail("Neon approval receipt does not match the immutable application approval.","VIDEO_APPROVAL_SNAPSHOT_MISMATCH");
      }
      const jobs=await runtime.videoApprovals.approvals.enqueue(local.id,ownerId);
      if(!Array.isArray(jobs)||jobs.length!==snapshot.shots.length||
         jobs.some((job,index)=>!job||job.shotIndex!==index||!UUID.test(String(job.jobId||"")))){
        throw fail("Neon did not confirm every approved shot in the durable queue.","VIDEO_QUEUE_RECEIPT_INVALID");
      }
      const changed=db.prepare("UPDATE video_generation_approvals SET status='consumed',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND owner_id=? AND status='approved_pending_submission'").run(local.id,ownerId);
      if(changed.changes===1){
        audit(ownerId,"video_generation.neon_staging_jobs_enqueued","video_generation_approval",local.id,
          {jobCount:jobs.length,jobIds:jobs.map(job=>job.jobId),requestHash:local.request_hash},local.project_id);
      }
      return {status:replay?200:202,body:{
        approval:{id:local.id,status:"processing",requestHash:local.request_hash,shotCount:snapshot.shots.length},
        jobs,idempotentReplay:replay||changed.changes===0,providerRequestsSubmitted:false,
        backend:"neon-postgres",message:"Approved shots are durably queued in isolated Neon staging. Provider execution remains controlled by the separately gated staging worker."
      }};
    }catch(error){
      const detail=safeError(error);
      const status=detail.code==="VIDEO_APPROVAL_IDEMPOTENCY_CONFLICT"||detail.code==="VIDEO_APPROVAL_SNAPSHOT_MISMATCH"?409:
        detail.code==="VIDEO_REPOSITORY_TIMEOUT"?503:502;
      return {status,body:{error:detail,providerRequestsSubmitted:false,backend:"neon-postgres"}};
    }
  }

  async function cancelJob({jobId,ownerId}={}){
    if(!UUID.test(String(jobId||""))||!UUID.test(String(ownerId||""))){
      return {status:400,body:{error:{code:"VIDEO_JOB_ID_INVALID",message:"A valid job and authenticated account are required."}}};
    }
    if(typeof runtime?.queue?.getOwnedJob!=="function"||typeof runtime?.queue?.cancelQueuedVideoJob!=="function"){
      return {status:503,body:{error:{code:"VIDEO_JOB_CANCELLATION_UNAVAILABLE",message:"Safe queued cancellation is not available in this Neon runtime."}}};
    }
    let job;
    try{job=await runtime.queue.getOwnedJob(jobId,ownerId);}
    catch{return {status:503,body:{error:{code:"VIDEO_JOB_LOOKUP_FAILED",message:"The owned job could not be verified. No cancellation was attempted."}}};}
    if(!job)return {status:404,body:{error:{code:"VIDEO_JOB_NOT_FOUND",message:"Video job not found."}}};
    if(job.jobType!=="video.generate"||!job.projectId){
      return {status:409,body:{error:{code:"VIDEO_JOB_NOT_CANCELLABLE",message:"Only project-scoped video generation jobs can be cancelled here."}}};
    }
    let allowed=false;
    try{allowed=await canWriteProject(ownerId,job.projectId)===true;}catch{}
    if(!allowed)return {status:404,body:{error:{code:"PROJECT_NOT_FOUND",message:"Project not found or editor access required."}}};
    let receipt;
    try{receipt=await runtime.queue.cancelQueuedVideoJob(jobId,ownerId);}
    catch{return {status:503,body:{error:{code:"VIDEO_JOB_CANCELLATION_UNCONFIRMED",message:"Cancellation could not be confirmed. Refresh the job before retrying."}}};}
    if(!receipt.cancelled){
      const conflicts=new Set(["provider_submission_possible","submission_record_exists","financial_reservation_not_active","terminal_job"]);
      const status=receipt.reason==="not_found"?404:409;
      const messages={
        provider_submission_possible:"This job is no longer queued. Provider submission or execution may have started, so no refund or cancellation is being claimed.",
        submission_record_exists:"A provider submission record exists. The job is held for provider reconciliation; credits will not be released automatically.",
        financial_reservation_not_active:"The financial reservation is not in an active state. No cancellation or refund was applied.",
        terminal_job:"This job is already terminal and cannot be cancelled again."
      };
      return {status,body:{error:{code:conflicts.has(receipt.reason)?"VIDEO_JOB_CANCELLATION_CONFLICT":"VIDEO_JOB_NOT_FOUND",message:messages[receipt.reason]||"The job could not be safely cancelled."},job:{id:jobId,status:receipt.status||job.status}}};
    }
    if(!receipt.replayed){
      audit(ownerId,"video_generation.neon_job_cancelled_before_submission","video_generation_job",jobId,
        {creditAdjustment:receipt.creditAdjustment,balance:receipt.balance,evidenceType:"verified_no_submission"},job.projectId);
    }
    return {status:200,body:{
      job:{id:jobId,status:"cancelled"},
      cancellation:{creditAdjustment:receipt.creditAdjustment,balance:receipt.balance,replayed:receipt.replayed},
      providerCancellation:"not_required_no_submission"
    }};
  }

  return Object.freeze({submit,cancelJob});
}
