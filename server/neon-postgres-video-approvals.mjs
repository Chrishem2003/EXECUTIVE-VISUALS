import { createHash, randomUUID } from "node:crypto";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const fail=(message,code)=>Object.assign(new Error(message),{code});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=value=>createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const amountFromMicros=value=>Number((Number(value)/1_000_000).toFixed(6));

function validateApproval(input){
 if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Neon approval registration requires an object.");
 for(const [key,value] of [["id",input.id],["ownerId",input.ownerId],["projectId",input.projectId]])if(!UUID.test(String(value||"")))throw new Error("Neon approval "+key+" must be a UUID.");
 if(typeof input.idempotencyKey!=="string"||input.idempotencyKey.length<8||input.idempotencyKey.length>200)throw new Error("Neon approval idempotency key is invalid.");
 if(!HASH.test(String(input.requestHash||"")))throw new Error("Neon approval request hash is invalid.");
 if(!/^[A-Z]{3}$/.test(String(input.currency||"")))throw new Error("Neon approval currency is invalid.");
 if(!Number.isSafeInteger(input.quotedAmountMicros)||input.quotedAmountMicros<1||!Number.isSafeInteger(input.budgetCeilingMicros)||input.budgetCeilingMicros<input.quotedAmountMicros)throw new Error("Neon approval quote and ceiling must be positive safe micro-units.");
 let snapshot=input.snapshotJson;
 if(typeof snapshot==="string"){try{snapshot=JSON.parse(snapshot);}catch{throw new Error("Neon approval snapshot is invalid JSON.");}}
 if(!snapshot||typeof snapshot!=="object"||Array.isArray(snapshot)||!Array.isArray(snapshot.shots)||snapshot.shots.length<1||snapshot.shots.length>12)throw new Error("Neon approval snapshot must contain 1–12 shots.");
 if(Buffer.byteLength(JSON.stringify(snapshot),"utf8")>1024*1024)throw new Error("Neon approval snapshot exceeds 1 MiB.");
 const shots=snapshot.shots.map((shot,index)=>{
  if(!shot||typeof shot!=="object"||Array.isArray(shot)||typeof shot.provider!=="string"||!shot.provider.trim()||typeof shot.model!=="string"||!shot.model.trim()||!Number.isSafeInteger(shot.estimatedCostMicros)||shot.estimatedCostMicros<1)throw new Error("Neon approval shot "+index+" is missing its provider, model or verified price.");
  const approvedMax=shot.approvedMaxAmountMicros===undefined?shot.estimatedCostMicros:shot.approvedMaxAmountMicros;
  if(!Number.isSafeInteger(approvedMax)||approvedMax<shot.estimatedCostMicros)throw new Error("Neon approval shot "+index+" has an invalid approved spending ceiling.");
  return shot;
 });
 if(shots.reduce((sum,shot)=>sum+shot.estimatedCostMicros,0)!==input.quotedAmountMicros)throw new Error("Neon approval shot prices do not sum to the approved quote.");
 const approvedTotal=shots.reduce((sum,shot)=>sum+(shot.approvedMaxAmountMicros===undefined?shot.estimatedCostMicros:shot.approvedMaxAmountMicros),0);
 if(!Number.isSafeInteger(approvedTotal)||approvedTotal>input.budgetCeilingMicros)throw new Error("Per-shot approved spending ceilings exceed the production budget ceiling.");
 return {...input,snapshotJson:snapshot};
}

/**
 * Durable bridge from the existing server-approved production snapshot to
 * Neon jobs. Customer credits are quoted by an injected server-side policy;
 * browser-supplied credit quantities are never accepted.
 */
export function createNeonVideoGenerationRepositories({pool,videoEnqueue,quoteCustomerCredits,approvalTtlSeconds=900}={}){
 if(!pool||typeof pool.connect!=="function")throw new Error("Neon approval bridge requires a PostgreSQL pool with transaction clients.");
 if(!videoEnqueue||typeof videoEnqueue.enqueueVideoGenerationJob!=="function")throw new Error("Neon approval bridge requires the atomic video enqueue adapter.");
 if(typeof quoteCustomerCredits!=="function")throw new Error("Neon approval bridge requires a server-side customer-credit quote policy.");
 if(!Number.isInteger(approvalTtlSeconds)||approvalTtlSeconds<30||approvalTtlSeconds>900)throw new Error("Neon budget approval TTL must be 30–900 seconds.");

 async function transaction(work){
  const client=await pool.connect();
  let began=false;
  try{await client.query("begin");began=true;const value=await work(client);await client.query("commit");began=false;return value;}
  catch(error){if(began)try{await client.query("rollback");}catch{}throw error;}
  finally{client.release();}
 }
 function approvalRow(row){
  if(!row)return null;
  return {id:row.id,ownerId:row.owner_id,projectId:row.project_id,requestHash:row.request_hash,
   snapshotJson:row.snapshot_json,currency:row.currency,quotedAmountMicros:Number(row.quoted_amount_micros),
   budgetCeilingMicros:Number(row.budget_ceiling_micros),status:row.status};
 }
 const approvals=Object.freeze({
  async register(raw){
   const a=validateApproval(raw);
   return transaction(async client=>{
    await client.query("insert into executive_visuals.video_generation_approvals(id,owner_id,project_id,idempotency_key,request_hash,snapshot_json,currency,quoted_amount_micros,budget_ceiling_micros) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7,$8::bigint,$9::bigint) on conflict do nothing",[
     a.id,a.ownerId,a.projectId,a.idempotencyKey,a.requestHash,JSON.stringify(a.snapshotJson),a.currency,a.quotedAmountMicros,a.budgetCeilingMicros
    ]);
    const found=await client.query("select * from executive_visuals.video_generation_approvals where id=$1::uuid for update",[a.id]);
    const row=found.rows?.[0];
    if(!row||row.owner_id!==a.ownerId||row.project_id!==a.projectId||row.idempotency_key!==a.idempotencyKey||row.request_hash!==a.requestHash||row.currency!==a.currency||Number(row.quoted_amount_micros)!==a.quotedAmountMicros||Number(row.budget_ceiling_micros)!==a.budgetCeilingMicros||JSON.stringify(canonical(row.snapshot_json))!==JSON.stringify(canonical(a.snapshotJson)))throw fail("Neon approval replay conflicts with the immutable approved snapshot.","VIDEO_APPROVAL_IDEMPOTENCY_CONFLICT");
    for(let index=0;index<a.snapshotJson.shots.length;index++){
     const shot=a.snapshotJson.shots[index],shotHash=digest({approvalId:a.id,shotIndex:index,shot});
     await client.query("insert into executive_visuals.video_generation_approval_shots(approval_id,shot_index,owner_id,project_id,provider,model,request_hash,estimated_cost_micros) values($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7,$8::bigint) on conflict(approval_id,shot_index) do nothing",[
      a.id,index,a.ownerId,a.projectId,shot.provider,shot.model,shotHash,shot.estimatedCostMicros
     ]);
    }
    return approvalRow(row);
   });
  },
  async get(id,{ownerId,projectId}={}){
   if(!UUID.test(String(id||""))||!UUID.test(String(ownerId||""))||!UUID.test(String(projectId||"")))throw fail("Neon approval lookup requires scoped UUIDs.","VIDEO_APPROVAL_SCOPE_INVALID");
   const result=await pool.query("select * from executive_visuals.video_generation_approvals where id=$1::uuid and owner_id=$2::uuid and project_id=$3::uuid limit 1",[id,ownerId,projectId]);
   return approvalRow(result.rows?.[0]||null);
  },
  async checkReadiness(){
   const result=await pool.query("select to_regclass('executive_visuals.video_generation_approvals') is not null as approvals_ready,to_regclass('executive_visuals.video_generation_approval_shots') is not null as shots_ready");
   const row=result.rows?.[0];
   return Object.freeze({configured:true,ready:row?.approvals_ready===true&&row?.shots_ready===true,approvalsReady:row?.approvals_ready===true,shotsReady:row?.shots_ready===true});
  },
  async enqueue(id,ownerId){
   if(!UUID.test(String(id||""))||!UUID.test(String(ownerId||"")))throw fail("Neon approval enqueue requires scoped UUIDs.","VIDEO_APPROVAL_SCOPE_INVALID");
   return transaction(async client=>{
    const found=await client.query("select * from executive_visuals.video_generation_approvals where id=$1::uuid and owner_id=$2::uuid for update",[id,ownerId]);
    const approval=found.rows?.[0];
    if(!approval)throw fail("Approved production was not found in Neon.","VIDEO_APPROVAL_NOT_FOUND");
    const shotsResult=await client.query("select * from executive_visuals.video_generation_approval_shots where approval_id=$1::uuid and owner_id=$2::uuid order by shot_index for update",[id,ownerId]);
    const shots=shotsResult.rows||[];
    const snapshot=approval.snapshot_json;
    if(shots.length!==snapshot.shots?.length)throw fail("Neon approval shot ledger is incomplete.","VIDEO_APPROVAL_SNAPSHOT_INVALID");
    const receipts=[];
    for(const row of shots){
     const shot=snapshot.shots[Number(row.shot_index)];
     if(!shot||shot.provider!==row.provider||shot.model!==row.model||shot.estimatedCostMicros!==Number(row.estimated_cost_micros)||!HASH.test(row.request_hash))throw fail("Neon shot ledger does not match the immutable approval.","VIDEO_APPROVAL_SNAPSHOT_MISMATCH");
     const approvedMaxAmountMicros=Number.isSafeInteger(shot.approvedMaxAmountMicros)?shot.approvedMaxAmountMicros:Number(row.estimated_cost_micros);
     let reservedCredits=row.reserved_credits===null?null:Number(row.reserved_credits);
     let budgetApprovalId=row.budget_approval_id||null;
     if(reservedCredits===null){
      const quote=quoteCustomerCredits({ownerId,projectId:approval.project_id,provider:row.provider,model:row.model,currency:approval.currency,amountMicros:approvedMaxAmountMicros,shot,approvalId:id,shotIndex:Number(row.shot_index)});
      if(quote&&typeof quote.then==="function")throw new Error("Customer-credit quote policy must be synchronous and deterministic.");
      if(!Number.isSafeInteger(quote)||quote<1||quote>100000000)throw fail("Server-side customer-credit quote is unavailable or outside the supported bounds.","VIDEO_CUSTOMER_CREDIT_QUOTE_INVALID");
      reservedCredits=quote;budgetApprovalId=randomUUID();
      await client.query("insert into executive_visuals.video_generation_budget_approvals(id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,approval_note,expires_at) values($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8::numeric,$9,clock_timestamp()+make_interval(secs=>$10))",[
       budgetApprovalId,ownerId,approval.project_id,row.provider,row.model,row.request_hash,approval.currency,amountFromMicros(approvedMaxAmountMicros),"Approved production "+id+" shot "+row.shot_index,approvalTtlSeconds
      ]);
      await client.query("update executive_visuals.video_generation_approval_shots set reserved_credits=$3::bigint,budget_approval_id=$4::uuid,updated_at=clock_timestamp() where approval_id=$1::uuid and shot_index=$2",[
       id,row.shot_index,reservedCredits,budgetApprovalId
      ]);
     }else if(!UUID.test(String(budgetApprovalId||"")))throw fail("Persisted per-shot budget approval is invalid.","VIDEO_APPROVAL_SNAPSHOT_INVALID");
     const idempotencyKey="video-shot:"+id+":"+row.shot_index;
     const input={...shot,provider:row.provider,model:row.model,requestHash:row.request_hash,approvalId:id,approvalRequestHash:approval.request_hash,shotIndex:Number(row.shot_index),estimated_cost:{amount:amountFromMicros(row.estimated_cost_micros),currency:approval.currency}};
     const enqueued=await client.query("select * from executive_visuals.enqueue_video_generation_job_v1($1::uuid,$2::uuid,$3,$4::jsonb,$5::uuid,$6::numeric,$7::bigint,$8)",[
      ownerId,approval.project_id,idempotencyKey,JSON.stringify(input),budgetApprovalId,amountFromMicros(approvedMaxAmountMicros),reservedCredits,2
     ]);
     const receipt=enqueued.rows?.[0];
     if(!receipt||!UUID.test(String(receipt.job_id||""))||!UUID.test(String(receipt.budget_reservation_id||""))||!UUID.test(String(receipt.credit_reservation_id||""))||typeof receipt.idempotent_replay!=="boolean")throw fail("Neon atomic enqueue returned an invalid per-shot receipt.","NEON_VIDEO_ENQUEUE_INVALID_RECEIPT");
     await client.query("update executive_visuals.video_generation_approval_shots set job_id=$3::uuid,updated_at=clock_timestamp() where approval_id=$1::uuid and shot_index=$2",[
      id,row.shot_index,receipt.job_id
     ]);
     receipts.push({jobId:receipt.job_id,shotIndex:Number(row.shot_index),status:receipt.job_status,idempotentReplay:receipt.idempotent_replay});
    }
    await client.query("update executive_visuals.video_generation_approvals set status='processing',updated_at=clock_timestamp() where id=$1::uuid",[id]);
    return receipts;
   });
  },
  async enqueueWorkflowNode(raw){
   if(!raw||typeof raw!=="object"||Array.isArray(raw))throw fail("Neon workflow dispatch requires a quote-bound approval object.","VIDEO_WORKFLOW_APPROVAL_INVALID");
   const {quoteId,ownerId,projectId,requestId,requestHash,provider,model,operation,input,estimatedAmount,approvedMaxAmount,expiresAt}=raw;
   if(!UUID.test(String(quoteId||""))||!UUID.test(String(ownerId||""))||!UUID.test(String(projectId||"")))throw fail("Neon workflow dispatch requires valid quote, owner and project IDs.","VIDEO_WORKFLOW_APPROVAL_INVALID");
   if(typeof requestId!=="string"||requestId.length<8||requestId.length>200||!/^[A-Za-z0-9._:-]+$/.test(requestId)||!HASH.test(String(requestHash||"")))throw fail("Neon workflow request identity is invalid.","VIDEO_WORKFLOW_APPROVAL_INVALID");
   if(provider!=="runway"||model!=="model-router"||!["text-to-video","image-to-video","video-to-video"].includes(operation))throw fail("This Neon workflow adapter only admits the explicitly registered Runway Model Router contract.","VIDEO_WORKFLOW_MODEL_UNSUPPORTED");
   if(!input||typeof input!=="object"||Array.isArray(input)||Buffer.byteLength(JSON.stringify(input),"utf8")>1024*1024)throw fail("Neon workflow input must be a bounded JSON object.","VIDEO_WORKFLOW_INPUT_INVALID");
   const expiry=Date.parse(String(expiresAt||""));
   if(!Number.isFinite(expiry)||expiry<=Date.now())throw fail("The approved workflow quote has expired.","VIDEO_WORKFLOW_QUOTE_EXPIRED");
   const quotedAmountMicros=Math.round(Number(estimatedAmount)*1000000);
   const budgetCeilingMicros=Math.round(Number(approvedMaxAmount)*1000000);
   if(!Number.isSafeInteger(quotedAmountMicros)||quotedAmountMicros<1||Math.abs(quotedAmountMicros/1000000-Number(estimatedAmount))>0.0000001||
      !Number.isSafeInteger(budgetCeilingMicros)||budgetCeilingMicros<quotedAmountMicros||budgetCeilingMicros>1000000000000||
      Math.abs(budgetCeilingMicros/1000000-Number(approvedMaxAmount))>0.0000001)throw fail("The workflow quote and approved USD ceiling must use bounded six-decimal amounts.","VIDEO_WORKFLOW_APPROVED_AMOUNT_INVALID");
   const shot={...input,provider,model,operation,estimatedCostMicros:quotedAmountMicros,
    approvedMaxAmountMicros:budgetCeilingMicros,workflowQuoteId:quoteId,workflowRequestId:requestId,
    workflowRequestHash:requestHash,quoteExpiresAt:new Date(expiry).toISOString(),
    routedProvider:typeof raw.routedProvider==="string"?raw.routedProvider.slice(0,100):"runway",
    routedModel:typeof raw.routedModel==="string"?raw.routedModel.slice(0,160):"model-router",
    estimatedProviderCredits:Number.isSafeInteger(raw.estimatedCredits)&&raw.estimatedCredits>0?raw.estimatedCredits:null,
    approvalNote:typeof raw.approvalNote==="string"?raw.approvalNote.slice(0,1000):"Approved in Video Studio"};
   const snapshotJson={shots:[shot],workflow:{kind:"video.generate",quoteId,requestId,requestHash,operation}};
   const registered=await approvals.register({id:quoteId,ownerId,projectId,idempotencyKey:requestId,requestHash,
    snapshotJson,currency:"USD",quotedAmountMicros,budgetCeilingMicros});
   if(!registered||registered.id!==quoteId||registered.ownerId!==ownerId||registered.projectId!==projectId||
      registered.requestHash!==requestHash||registered.quotedAmountMicros!==quotedAmountMicros||
      registered.budgetCeilingMicros!==budgetCeilingMicros)throw fail("Neon workflow approval registration did not match the exact approved quote.","VIDEO_WORKFLOW_APPROVAL_RECEIPT_INVALID");
   const jobs=await approvals.enqueue(quoteId,ownerId);
   if(!Array.isArray(jobs)||jobs.length!==1||!UUID.test(String(jobs[0]?.jobId||"")))throw fail("Neon workflow enqueue did not return one durable job receipt.","VIDEO_WORKFLOW_JOB_RECEIPT_INVALID");
   return Object.freeze({backend:"neon-postgres",approvalId:quoteId,jobId:jobs[0].jobId,status:jobs[0].status,
    idempotentReplay:jobs[0].idempotentReplay===true,providerRequestsSubmitted:false});
  }
 });
 return Object.freeze({approvals});
}
