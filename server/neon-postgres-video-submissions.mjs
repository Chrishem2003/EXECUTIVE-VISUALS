const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(message,code)=>Object.assign(new Error(message),{code});
function required(value,label,max=256){if(typeof value!=="string"||!value.trim()||value.length>max)throw new Error(label+" is required and must be bounded.");return value;}
function lease(value){if(!UUID.test(String(value||"")))throw new Error("A valid worker lease token is required.");return value;}
function metadata(value){if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Submission metadata must be an object.");if(Buffer.byteLength(JSON.stringify(value),"utf8")>8000)throw new Error("Submission metadata exceeds the 8000-byte limit.");return value;}
function bool(result,operation){if(typeof result.rows?.[0]?.result!=="boolean")throw fail("Neon submission ledger "+operation+" returned an invalid result.","NEON_SUBMISSION_INVALID_RESULT");return result.rows[0].result;}
export function createNeonVideoSubmissionLedger({pool}={}){
 if(!pool||typeof pool.query!=="function")throw new Error("Neon video submission ledger requires a PostgreSQL pool.");
 async function query(text,values=[]){try{return await pool.query(text,values);}catch(error){throw fail(String(error?.message||"Neon submission ledger request failed.").slice(0,300),"NEON_SUBMISSION_DATABASE_ERROR");}}
 return Object.freeze({
  async prepare({jobId,ownerId,workerId,leaseToken,provider,model,requestHash}={}){
   for(const [v,n,m] of [[jobId,"Job ID"],[ownerId,"Owner ID"],[workerId,"Worker ID",128],[provider,"Provider",100],[model,"Model",160]])required(v,n,m||256);
   if(!UUID.test(jobId)||!UUID.test(ownerId)||! /^[a-f0-9]{64}$/.test(String(requestHash||"")))throw new Error("Submission identity and request hash are invalid.");
   const r=await query("select * from executive_visuals.prepare_video_generation_submission_v2($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7)",[jobId,ownerId,workerId,lease(leaseToken),provider,model,requestHash]);
   const row=r.rows?.[0];if(!row||row.job_id!==jobId||row.owner_id!==ownerId||row.request_hash!==requestHash)throw fail("Neon submission prepare returned an invalid or mismatched record.","NEON_SUBMISSION_INVALID_RESULT");return row;
  },
  async begin(jobId,workerId,token){required(jobId,"Job ID");required(workerId,"Worker ID",128);return bool(await query("select executive_visuals.begin_video_generation_submission_v2($1::uuid,$2,$3::uuid) as result",[jobId,workerId,lease(token)]),"begin");},
  async record(jobId,workerId,providerTaskId,details={},token){required(jobId,"Job ID");required(workerId,"Worker ID",128);required(providerTaskId,"Provider task ID");metadata(details);return bool(await query("select executive_visuals.record_video_generation_submission_v2($1::uuid,$2,$3::uuid,$4,$5::jsonb) as result",[jobId,workerId,lease(token),providerTaskId,JSON.stringify(details)]),"record");},
  async markUnknown(jobId,workerId,errorCode="VIDEO_SUBMISSION_AMBIGUOUS",token){required(jobId,"Job ID");required(workerId,"Worker ID",128);required(errorCode,"Error code",100);return bool(await query("select executive_visuals.mark_video_generation_submission_unknown_v2($1::uuid,$2,$3::uuid,$4) as result",[jobId,workerId,lease(token),errorCode]),"mark unknown");},
  async retry(jobId,workerId,token,errorCode="PROVIDER_RETRYABLE_REJECTION"){required(jobId,"Job ID");required(workerId,"Worker ID",128);required(errorCode,"Error code",100);return bool(await query("select executive_visuals.retry_video_generation_submission_v1($1::uuid,$2,$3::uuid,$4) as result",[jobId,workerId,lease(token),errorCode]),"retry");},
  async reconcileUnknown(jobId,providerTaskId,evidenceReference,details={}){required(jobId,"Job ID");required(providerTaskId,"Provider task ID");required(evidenceReference,"Evidence reference",1000);metadata(details);return bool(await query("select executive_visuals.reconcile_unknown_video_generation_submission($1::uuid,$2,$3,$4::jsonb) as result",[jobId,providerTaskId,evidenceReference,JSON.stringify(details)]),"reconcile");},
  async finish(jobId,workerId,state,details={},token){required(jobId,"Job ID");required(workerId,"Worker ID",128);if(!["succeeded","failed","cancelled"].includes(state))throw new Error("Submission terminal state must be succeeded, failed or cancelled.");metadata(details);return bool(await query("select executive_visuals.finish_video_generation_submission_v2($1::uuid,$2,$3::uuid,$4,$5::jsonb) as result",[jobId,workerId,lease(token),state,JSON.stringify(details)]),"finish");},
  async get(jobId){required(jobId,"Job ID");if(!UUID.test(jobId))throw new Error("Job ID must be a UUID.");const r=await query("select * from executive_visuals.get_video_generation_submission($1::uuid)",[jobId]);if(!Array.isArray(r.rows)||r.rows.length>1||r.rows[0]?.job_id&&r.rows[0].job_id!==jobId)throw fail("Neon submission lookup returned an invalid result.","NEON_SUBMISSION_INVALID_RESULT");return r.rows[0]||null;}
 });
}
