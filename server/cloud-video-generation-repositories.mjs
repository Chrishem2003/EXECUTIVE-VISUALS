const SCHEMA="executive_visuals";
const RPC=new Set(["register_video_generation_approval","enqueue_approved_video_generation","reserve_video_generation_task_v2","transition_video_generation_task_v2","transition_video_generation_task_reconciliation_v1","claim_video_generation_cancellations"]);
const fail=(message,code)=>Object.assign(new Error(message),{code});
function baseUrl(value){
 let url;try{url=new URL(value);}catch{throw new Error("Cloud video repository URL must be an absolute URL.");}
 const local=["localhost","127.0.0.1","::1","[::1]"].includes(url.hostname.toLowerCase());
 if((url.protocol!=="https:"&&!(local&&url.protocol==="http:"))||url.username||url.password||url.search||url.hash)throw new Error("Cloud video repository URL must use HTTPS and contain no credentials, query or fragment.");
 return url.origin;
}
function object(value,label){
 if(value&&typeof value==="object"&&!Array.isArray(value))return value;
 try{const parsed=JSON.parse(String(value||"{}"));if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))return parsed;}catch{}
 throw fail(label+" must be an object.","VIDEO_REPOSITORY_INVALID_DATA");
}
function taskRow(row){
 if(!row)return null;
 return {id:row.id,state:row.state,providerTaskId:row.provider_task_id||null,provider:row.provider||"runway",model:row.model||null,
  estimatedCostCredits:row.estimated_cost_credits===null?null:Number(row.estimated_cost_credits),
  outputAssetId:row.output_asset_id||null,error:row.error||null,shotIndex:row.shot_index,
  estimatedCostMicros:Number(row.estimated_cost_micros),currency:row.currency};
}
function approvalRow(row){
 if(!row)return null;
 const snapshot=object(row.snapshot_json,"Approval snapshot");
 return {id:row.id,ownerId:row.owner_id,projectId:row.project_id,requestHash:row.request_hash,
  snapshotJson:snapshot,shots:Array.isArray(snapshot.shots)?snapshot.shots:[],
  currency:row.currency,quotedAmountMicros:Number(row.quoted_amount_micros),
  budgetCeilingMicros:Number(row.budget_ceiling_micros),status:row.status};
}
export function createCloudVideoGenerationRepositories({url=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl=globalThis.fetch,timeoutMs=15000}={}){
 if(!url||!serviceRoleKey)throw new Error("Cloud video repositories require server-side Supabase credentials.");
 if(typeof fetchImpl!=="function")throw new Error("Cloud video repositories require fetch.");
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw new Error("Cloud video repository timeout is invalid.");
 const base=baseUrl(url);
 async function request(path,{method="GET",body,prefer}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const headers={apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,accept:"application/json","accept-profile":SCHEMA,"content-profile":SCHEMA};
   if(body!==undefined)headers["content-type"]="application/json";
   if(prefer)headers.prefer=prefer;
   const response=await fetchImpl(base+"/rest/v1/"+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});
   const text=await response.text();let parsed=null;
   if(text){try{parsed=JSON.parse(text);}catch{throw fail("Cloud video repository returned non-JSON data (HTTP "+response.status+").","VIDEO_REPOSITORY_INVALID_RESPONSE");}}
   if(!response.ok){
    const message=typeof parsed?.message==="string"?parsed.message.replaceAll(serviceRoleKey,"[redacted]").slice(0,300):"Cloud video repository request failed.";
    throw fail(message,"VIDEO_REPOSITORY_HTTP_"+response.status);
   }
   return parsed;
  }catch(error){if(error?.name==="AbortError")throw fail("Cloud video repository request timed out.","VIDEO_REPOSITORY_TIMEOUT");throw error;}
  finally{clearTimeout(timer);}
 }
 async function rpc(name,args){
  if(!RPC.has(name))throw new Error("Unsupported cloud video repository operation.");
  const rows=await request("rpc/"+name,{method:"POST",body:args});
  if(!Array.isArray(rows))throw fail("Cloud video repository RPC returned an invalid result.","VIDEO_REPOSITORY_INVALID_RESPONSE");
  return rows;
 }
 const approvals=Object.freeze({
  async register({id,ownerId,projectId,idempotencyKey,requestHash,snapshotJson,currency,quotedAmountMicros,budgetCeilingMicros}={}){
   if(!id||!ownerId||!projectId||!idempotencyKey||!requestHash)throw fail("Cloud approval registration is missing required identity fields.","VIDEO_APPROVAL_INVALID");
   const rows=await rpc("register_video_generation_approval",{p_id:id,p_owner_id:ownerId,p_project_id:projectId,p_idempotency_key:idempotencyKey,p_request_hash:requestHash,p_snapshot_json:object(snapshotJson,"Approval snapshot"),p_currency:currency,p_quoted_amount_micros:quotedAmountMicros,p_budget_ceiling_micros:budgetCeilingMicros});
   if(rows.length!==1)throw fail("Cloud approval registration was not confirmed.","VIDEO_APPROVAL_PERSISTENCE_FAILED");
   return approvalRow(rows[0]);
  },
  async get(id,{ownerId,projectId}={}){
   if(!id||!ownerId||!projectId)throw fail("Cloud approval lookup requires approval, owner and project IDs.","VIDEO_APPROVAL_SCOPE_INVALID");
   const query="video_generation_approvals?select=*&id=eq."+encodeURIComponent(id)+"&owner_id=eq."+encodeURIComponent(ownerId)+"&project_id=eq."+encodeURIComponent(projectId)+"&limit=1";
   const rows=await request(query);
   if(!Array.isArray(rows)||rows.length>1)throw fail("Cloud approval lookup returned an invalid result.","VIDEO_REPOSITORY_INVALID_RESPONSE");
   return approvalRow(rows[0]||null);
  },
  async enqueue(id,ownerId){
   const rows=await rpc("enqueue_approved_video_generation",{p_approval_id:id,p_owner_id:ownerId});
   return rows.map(row=>({jobId:row.job_id,shotIndex:Number(row.shot_index),status:row.job_status}));
  }
 });
 const tasks=Object.freeze({
  async claimCancellationPending(workerId,limit=20){
   if(typeof workerId!=="string"||!workerId.trim()||workerId.length>128||!Number.isInteger(limit)||limit<1||limit>100)
    throw fail("Cancellation reconciliation worker and limit are invalid.","VIDEO_TASK_QUERY_INVALID");
   const rows=await rpc("claim_video_generation_cancellations",{p_worker_id:workerId,p_limit:limit,p_lease_seconds:60});
   return rows.map(taskRow);
  },
  async reserveSubmission({jobId,workerId,leaseToken,approvalId,shotIndex,ownerId,projectId,requestHash,currency,estimatedCostMicros}={}){
   if(typeof jobId!=="string"||!jobId||typeof workerId!=="string"||!workerId.trim()||typeof leaseToken!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseToken))
    throw fail("Video task reservation requires a valid current worker lease.","VIDEO_WORKER_LEASE_LOST");
   const rows=await rpc("reserve_video_generation_task_v2",{p_job_id:jobId,p_worker_id:workerId,p_lease_token:leaseToken,p_approval_id:approvalId,p_shot_index:shotIndex,p_owner_id:ownerId,p_project_id:projectId,p_request_hash:requestHash,p_currency:currency,p_estimated_cost_micros:estimatedCostMicros});
   if(rows.length!==1)throw fail("Atomic video task reservation was not confirmed.","VIDEO_TASK_RESERVATION_FAILED");
   return taskRow(rows[0]);
  },
  async transition({id,jobId,workerId,leaseToken,from,to,providerTaskId=null,provider="runway",model=null,estimatedCostCredits=null,providerStatus=null,error=null,outputAssetId=null}={}){
   if(typeof jobId!=="string"||!jobId||typeof workerId!=="string"||!workerId.trim()||typeof leaseToken!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseToken))
    throw fail("Video task transition requires a valid current worker lease.","VIDEO_WORKER_LEASE_LOST");
   const rows=await rpc("transition_video_generation_task_v2",{p_job_id:jobId,p_worker_id:workerId,p_lease_token:leaseToken,p_task_id:id,p_from_states:from,p_to_state:to,p_provider_task_id:providerTaskId,p_provider:provider,p_model:model,p_estimated_cost_credits:estimatedCostCredits,p_provider_status:providerStatus,p_error:error,p_output_asset_id:outputAssetId});
   if(rows.length!==1)throw fail("Durable video task transition was not confirmed.","VIDEO_TASK_TRANSITION_FAILED");
   return taskRow(rows[0]);
  },
  markSubmitting(id,lease={}){return this.transition({id,...lease,from:["reserved"],to:"submitting"});},
  markSubmitted(id,value={},lease={}){return this.transition({id,...lease,from:["submitting"],to:"submitted",providerTaskId:value.providerTaskId,provider:value.provider||"runway",model:value.model,estimatedCostCredits:value.estimatedCostCredits});},
  markSubmissionUnknown(id,value={},lease={}){return this.transition({id,...lease,from:["submitting"],to:"submission_unknown",error:{code:value.code||"VIDEO_GATEWAY_SUBMISSION_UNKNOWN"}});},
  markProcessing(id,value={},lease={}){return this.transition({id,...lease,from:["submitted","processing"],to:"processing",providerStatus:value.providerStatus});},
  markFailed(id,value={},lease={}){return this.transition({id,...lease,from:["submitting","submitted","processing"],to:"failed",error:{code:value.code||"VIDEO_PROVIDER_FAILED",message:String(value.message||"Provider task failed.").slice(0,300)}});},
  markCancellationRequested(id,value={},lease={}){return this.transition({id,...lease,from:["reserved","submitted","processing","cancel_requested"],to:"cancel_requested",providerStatus:value.providerStatus||"CANCEL_REQUESTED"});},
  markCancelled(id,value={},lease={}){return this.transition({id,...lease,from:["reserved","submitted","processing","cancel_requested"],to:"cancelled",providerStatus:value.providerStatus||"CANCELLED"});},
  async markCancelledByReconciler(id,value={},workerId){
   if(typeof workerId!=="string"||!workerId.trim()||workerId.length>128)throw fail("Cancellation reconciler worker ID is invalid.","VIDEO_TASK_QUERY_INVALID");
   const rows=await rpc("transition_video_generation_task_reconciliation_v1",{p_task_id:id,p_worker_id:workerId,p_from_states:["reserved","submitted","processing","cancel_requested"],p_to_state:"cancelled",p_provider_status:value.providerStatus||"CANCELLED"});
   if(rows.length!==1)throw fail("Cancellation reconciliation transition was not confirmed.","VIDEO_TASK_TRANSITION_FAILED");
   return taskRow(rows[0]);
  },
  markSucceeded(id,value={},lease={}){return this.transition({id,...lease,from:["submitted","processing"],to:"succeeded",providerTaskId:value.providerTaskId,outputAssetId:value.asset?.id||null});}
 });
 return Object.freeze({approvals,tasks});
}
