const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const STATUSES=new Set(["queued","processing","reviewing","succeeded","partial","failed","cancelled","blocked","needs_input"]);
const fail=(message,code)=>Object.assign(new Error(message),{code});
function required(value,label,max=256){if(typeof value!=="string"||!value.trim()||value.length>max)throw new Error(label+" is required and must be bounded.");return value;}
export function createNeonVideoEnqueue({pool}={}){
 if(!pool||typeof pool.query!=="function")throw new Error("Neon video enqueue requires a PostgreSQL pool.");
 async function query(sql,values=[]){try{return await pool.query(sql,values);}catch(error){const e=fail(String(error?.message||"Neon video enqueue failed.").slice(0,300),"NEON_VIDEO_ENQUEUE_DATABASE_ERROR");e.sqlState=typeof error?.code==="string"?error.code:null;throw e;}}
 return Object.freeze({
  async enqueueVideoGenerationJob({ownerId,projectId=null,idempotencyKey,input,approvalId,reservedAmount,reservedCredits,maxAttempts=2}={}){
   if(!UUID.test(String(ownerId||""))||(projectId!==null&&!UUID.test(String(projectId))))throw new Error("Video enqueue owner and optional project IDs must be UUIDs.");
   required(idempotencyKey,"Video idempotency key",200);
   if(!input||typeof input!=="object"||Array.isArray(input)||Buffer.byteLength(JSON.stringify(input),"utf8")>1048576)throw new Error("Video enqueue input must be an object no larger than 1 MiB.");
   required(input.provider,"Provider",100);required(input.model,"Model",160);
   if(!HASH.test(String(input.requestHash||"")))throw new Error("Video enqueue requires the canonical SHA-256 request hash.");
   if(!UUID.test(String(approvalId||"")))throw new Error("A scoped budget approval UUID is required.");
   if(typeof reservedAmount!=="number"||!Number.isFinite(reservedAmount)||reservedAmount<=0||reservedAmount>1000000)throw new Error("Reserved provider amount must be positive and bounded.");
   if(!Number.isSafeInteger(reservedCredits)||reservedCredits<1||reservedCredits>100000000)throw new Error("Reserved customer credits must be a positive bounded integer.");
   if(!Number.isInteger(maxAttempts)||maxAttempts<1||maxAttempts>10)throw new Error("Maximum attempts must be between 1 and 10.");
   return query("select * from executive_visuals.enqueue_video_generation_job_v1($1::uuid,$2::uuid,$3,$4::jsonb,$5::uuid,$6::numeric,$7::bigint,$8)",[
    ownerId,projectId,idempotencyKey,JSON.stringify(input),approvalId,reservedAmount,reservedCredits,maxAttempts
   ]).then(result=>{
    const row=result.rows?.[0];
    if(!row||!UUID.test(String(row.job_id||""))||!STATUSES.has(row.job_status)||typeof row.idempotent_replay!=="boolean"||!UUID.test(String(row.budget_reservation_id||""))||!UUID.test(String(row.credit_reservation_id||""))||!Number.isFinite(Number(row.available_credits)))throw fail("Neon atomic video enqueue returned an invalid receipt.","NEON_VIDEO_ENQUEUE_INVALID_RECEIPT");
    return Object.freeze({jobId:row.job_id,status:row.job_status,idempotentReplay:row.idempotent_replay,budgetReservationId:row.budget_reservation_id,creditReservationId:row.credit_reservation_id,availableCredits:Number(row.available_credits)});
   });
  },
  async checkReadiness(){
   const result=await query("select to_regprocedure('executive_visuals.enqueue_video_generation_job_v1(uuid,uuid,text,jsonb,uuid,numeric,bigint,integer)') is not null as atomic_video_enqueue_ready");
   const ready=result.rows?.[0]?.atomic_video_enqueue_ready===true;
   return Object.freeze({configured:true,ready,atomicVideoEnqueueReady:ready});
  }
 });
}
