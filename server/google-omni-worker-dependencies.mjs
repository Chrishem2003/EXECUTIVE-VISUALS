import { createHash } from "node:crypto";

const MODEL="gemini-omni-1.1-flash";
const ORIGIN="https://generativelanguage.googleapis.com";
const FILE_URI=/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[A-Za-z0-9_-]+$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(message,code)=>Object.assign(new Error(message),{code});
const text=value=>typeof value==="string"?value.trim():"";

function safeOrigin(value){
 let parsed;try{parsed=new URL(value);}catch{throw new Error("Google Omni worker requires a valid Supabase URL.");}
 if(parsed.protocol!=="https:"||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=="/")throw new Error("Google Omni worker Supabase URL must be a clean HTTPS origin.");
 return parsed.origin;
}

export function createGoogleOmniWorkerDependencies({
 url=process.env.SUPABASE_URL,
 serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,
 env=process.env,
 fetchImpl=globalThis.fetch,
 queue,
 ledger,
 interactions,
 assets,
 filesGateway,
 now=()=>Date.now(),
 connectionCacheMs=60000
}={}){
 if(!url||!serviceRoleKey||typeof fetchImpl!=="function")throw new TypeError("Google Omni worker policy requires server-only Supabase credentials and fetch.");
 if(!queue||typeof queue.assertLease!=="function")throw new TypeError("Google Omni worker policy requires a lease-aware queue.");
 if(!ledger||typeof ledger.get!=="function")throw new TypeError("Google Omni worker policy requires the durable submission ledger.");
 if(!interactions||typeof interactions.findInteraction!=="function")throw new TypeError("Google Omni worker policy requires the durable interaction repository.");
 if(!assets||typeof assets.get!=="function"||!filesGateway||typeof filesGateway.resolveAsset!=="function")throw new TypeError("Google Omni worker policy requires owner-scoped private assets and the Gemini Files gateway.");
 if(!Number.isInteger(connectionCacheMs)||connectionCacheMs<0||connectionCacheMs>300000)throw new Error("Google Omni connection verification cache is invalid.");
 const base=safeOrigin(url);
 let connectionCache=null;

 async function databaseRows(table,params){
  if(!["video_generation_budget_reservations","video_generation_budget_approvals"].includes(table))throw new Error("Unsupported Google Omni approval query.");
  const query=new URLSearchParams(params);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
   const response=await fetchImpl(base+"/rest/v1/"+table+"?"+query.toString(),{
    method:"GET",
    headers:{apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,accept:"application/json","accept-profile":"executive_visuals"},
    signal:controller.signal,redirect:"error"
   });
   const raw=await response.text();
   if(Buffer.byteLength(raw)>256*1024)throw fail("Google Omni approval evidence exceeded its size limit.","GOOGLE_OMNI_APPROVAL_EVIDENCE_INVALID");
   let rows=[];if(raw){try{rows=JSON.parse(raw);}catch{throw fail("Google Omni approval evidence returned invalid JSON.","GOOGLE_OMNI_APPROVAL_EVIDENCE_INVALID");}}
   if(!response.ok||!Array.isArray(rows)||rows.length>2)throw fail("Google Omni approval evidence could not be verified.","GOOGLE_OMNI_APPROVAL_EVIDENCE_UNAVAILABLE");
   return rows;
  }catch(error){if(error?.name==="AbortError")throw fail("Google Omni approval evidence lookup timed out.","GOOGLE_OMNI_APPROVAL_EVIDENCE_UNAVAILABLE");throw error;}
  finally{clearTimeout(timer);}
 }

 async function verifyApprovalContext(context,allowedStates){
  if(!UUID.test(text(context?.jobId))||!UUID.test(text(context?.ownerId))||
     !/^[a-f0-9]{64}$/.test(text(context?.requestHash))||
     !text(context?.workerId)||!UUID.test(text(context?.leaseToken))||
     context?.approvedBy!==context?.ownerId||!Number.isFinite(Date.parse(text(context?.approvedAt)))||
     !Number.isFinite(Number(context?.estimatedCost?.amount))||Number(context.estimatedCost.amount)<=0||
     context?.estimatedCost?.currency!=="USD")return false;
  if(await queue.assertLease(context.jobId,context.workerId,context.leaseToken)!==true)return false;
  const submission=await ledger.get(context.jobId);
  if(!submission||submission.job_id!==context.jobId||submission.owner_id!==context.ownerId||
     submission.provider!=="google"||submission.model!==MODEL||submission.request_hash!==context.requestHash||
     !allowedStates.includes(submission.state))return false;
  const reservations=await databaseRows("video_generation_budget_reservations",{
   select:"id,job_id,approval_id,owner_id,project_id,provider,model,currency,reserved_amount,state",
   job_id:"eq."+context.jobId,owner_id:"eq."+context.ownerId,limit:"2"
  });
  if(reservations.length!==1)return false;
  const reservation=reservations[0],projectId=context.projectId||null;
  if(reservation.job_id!==context.jobId||reservation.owner_id!==context.ownerId||
     (reservation.project_id||null)!==projectId||reservation.provider!=="google"||reservation.model!==MODEL||
     reservation.currency!=="USD"||reservation.state!=="reserved"||
     !Number.isFinite(Number(reservation.reserved_amount))||
     Math.abs(Number(reservation.reserved_amount)-Number(context.estimatedCost.amount))>0.000001||
     !UUID.test(text(reservation.approval_id)))return false;
  if(context.budgetApprovalId&&context.budgetApprovalId!==reservation.approval_id)return false;
  const approvals=await databaseRows("video_generation_budget_approvals",{
   select:"id,owner_id,project_id,provider,model,request_hash,currency,approved_max_amount,consumed_at",
   id:"eq."+reservation.approval_id,owner_id:"eq."+context.ownerId,limit:"2"
  });
  if(approvals.length!==1)return false;
  const approval=approvals[0];
  return approval.id===reservation.approval_id&&approval.owner_id===context.ownerId&&
   (approval.project_id||null)===projectId&&approval.provider==="google"&&approval.model===MODEL&&
   approval.request_hash===context.requestHash&&approval.currency==="USD"&&Boolean(approval.consumed_at)&&
   Number.isFinite(Number(approval.approved_max_amount))&&
   Number(approval.approved_max_amount)+0.000001>=Number(reservation.reserved_amount);
 }

 async function assertApprovedSubmission({plan,context}={}){
  if(!plan||plan.policy?.provider!=="google"||plan.policy?.model!==MODEL||plan.policy?.requiresApproval!==true)return false;
  return verifyApprovalContext(context,["submitting"]);
 }
 async function authorizeInteraction({interactionId,context}={}){
  if(!/^v1_[A-Za-z0-9_-]{6,200}$/.test(text(interactionId))||
     !UUID.test(text(context?.ownerId))||!UUID.test(text(context?.jobId)))return false;
  const record=await interactions.findInteraction({
   interactionId,ownerId:context.ownerId,projectId:context.projectId||null,jobId:context.jobId
  });
  return Boolean(record&&record.provider==="google"&&record.model===MODEL&&
   record.interactionId===interactionId&&record.ownerId===context.ownerId&&
   (record.projectId||null)===(context.projectId||null)&&record.jobId===context.jobId&&
   !["deleting","deleted"].includes(record.state));
 }

 async function preparePlan(input,{job}={}){
  if(!job||!UUID.test(text(job.id))||!UUID.test(text(job.owner_id))||job.job_type!=="video.generate"||
     !input||input.provider!=="google"||input.model!==MODEL||
     !/^[a-f0-9]{64}$/.test(text(input.requestHash))||
     !text(input.prompt)||input.prompt.length>12000)throw fail("Gemini Omni request is invalid.","GEMINI_OMNI_PLAN_INVALID");
  const ownerId=job.owner_id,projectId=job.project_id||null;
  const approvalContext={
   jobId:job.id,ownerId,projectId,requestHash:input.requestHash,
   workerId:job.lease_owner,leaseToken:job.lease_token,
   approvedBy:job.approved_by,approvedAt:job.approved_at,
   budgetApprovalId:job.budget_approval_id||input.budgetApprovalId||null,
   estimatedCost:job.estimated_cost
  };
  if(!await verifyApprovalContext(approvalContext,["prepared"]))throw fail("Gemini Omni private input preparation requires a current lease and consumed matching budget approval.","GEMINI_OMNI_APPROVAL_REQUIRED");
  if(input.lastFrameAssetId||input.endFrameAssetId)throw fail("Gemini Omni last-frame locking is not yet supported by this worker path.","GEMINI_OMNI_UNSUPPORTED_INPUT");
  const operation=text(input.operation)||(text(input.previousInteractionId)||text(input.sourceVideoAssetId)?"edit":"generate");
  if(!["generate","edit","extend"].includes(operation))throw fail("Gemini Omni operation is unsupported.","GEMINI_OMNI_UNSUPPORTED_INPUT");
  const aspectRatio=text(input.aspectRatio)||"16:9";
  if(!["16:9","9:16"].includes(aspectRatio))throw fail("Gemini Omni currently supports 16:9 or 9:16 output.","GEMINI_OMNI_UNSUPPORTED_INPUT");
  if(input.resolution!==undefined&&!["provider_default","720p"].includes(input.resolution))throw fail("Gemini Omni worker is budgeted for 720p output only.","GEMINI_OMNI_UNSUPPORTED_INPUT");
  if(!Number.isInteger(input.durationSeconds)||input.durationSeconds<3||input.durationSeconds>10)throw fail("Gemini Omni reservation duration must be between 3 and 10 seconds.","GEMINI_OMNI_UNSUPPORTED_INPUT");
  const firstFrameId=text(input.firstFrameAssetId||input.startFrameAssetId);
  const sourceVideoId=text(input.sourceVideoAssetId);
  const imageIds=Array.isArray(input.referenceImageAssetIds)?input.referenceImageAssetIds:[];
  const videoIds=Array.isArray(input.referenceVideoAssetIds)?input.referenceVideoAssetIds:[];
  if(imageIds.length>5||videoIds.length>3)throw fail("Gemini Omni reference asset limits were exceeded.","GEMINI_OMNI_UNSUPPORTED_INPUT");
  if(operation==="generate"&&(input.previousInteractionId||sourceVideoId))throw fail("Gemini Omni generate mode cannot include an existing video or interaction.","GEMINI_OMNI_UNSUPPORTED_INPUT");
  if(["edit","extend"].includes(operation)&&!input.previousInteractionId&&!sourceVideoId)throw fail("Gemini Omni edit and extend require a previous interaction or private source video.","GEMINI_OMNI_UNSUPPORTED_INPUT");
  if(sourceVideoId&&operation==="generate")throw fail("Gemini Omni source-video input requires edit or extend mode.","GEMINI_OMNI_UNSUPPORTED_INPUT");
  if(firstFrameId&&sourceVideoId)throw fail("Gemini Omni image-to-video and source-video edit inputs must be submitted as separate operations.","GEMINI_OMNI_UNSUPPORTED_INPUT");
  if(input.previousInteractionId){
   const previous=await interactions.findInteraction({interactionId:input.previousInteractionId,ownerId,projectId});
   if(!previous||previous.provider!=="google"||previous.model!==MODEL||previous.ownerId!==ownerId||
      (previous.projectId||null)!==projectId||previous.state!=="succeeded")throw fail("Gemini Omni previous interaction is not available to this owner and project.","GEMINI_OMNI_INTERACTION_FORBIDDEN");
  }
  async function filePart(assetId,kind){
   if(!UUID.test(text(assetId)))throw fail("Gemini Omni private reference asset ID is invalid.","GEMINI_OMNI_ASSET_INVALID");
   const asset=await assets.get({ownerId,assetId});
   if((asset.projectId||null)!==projectId)throw fail("Gemini Omni reference asset belongs to another project.","GEMINI_OMNI_ASSET_FORBIDDEN");
   if(kind==="image"&&!String(asset.mediaType||"").startsWith("image/"))throw fail("Gemini Omni image reference must be an image asset.","GEMINI_OMNI_ASSET_INVALID");
   if(kind==="video"&&!String(asset.mediaType||"").startsWith("video/"))throw fail("Gemini Omni video reference must be a video asset.","GEMINI_OMNI_ASSET_INVALID");
   const file=await filesGateway.resolveAsset({assetId,ownerId,projectId,mediaType:asset.mediaType});
   if(!file||!FILE_URI.test(text(file.uri))||file.mediaType!==asset.mediaType||
      !Number.isFinite(Date.parse(text(file.expiresAt)))||Date.parse(file.expiresAt)<=now())throw fail("Gemini Files did not return a valid active private media reference.","GEMINI_OMNI_FILE_PREPARATION_FAILED");
   return{type:kind,uri:file.uri};
  }
  const parts=[];
  if(sourceVideoId)parts.push(await filePart(sourceVideoId,"video"));
  if(firstFrameId)parts.push(await filePart(firstFrameId,"image"));
  for(const id of imageIds)parts.push(await filePart(id,"image"));
  for(const id of videoIds)parts.push(await filePart(id,"video"));
  parts.push({type:"text",text:input.prompt});
  if(parts.length>10)throw fail("Gemini Omni multimodal input exceeds the ten-part limit.","GEMINI_OMNI_UNSUPPORTED_INPUT");
  const task=sourceVideoId||input.previousInteractionId?(operation==="extend"?"extend":"edit"):
   firstFrameId&&!imageIds.length&&!videoIds.length?"image_to_video":
   imageIds.length||videoIds.length?"reference_to_video":null;
  const payload={
   model:MODEL,input:parts,
   response_format:{type:"video",aspect_ratio:aspectRatio,resolution:"720p",delivery:"uri"}
  };
  if(input.previousInteractionId)payload.previous_interaction_id=input.previousInteractionId;
  if(task)payload.generation_config={video_config:{task}};
  return Object.freeze({
   endpoint:ORIGIN+"/v1beta/interactions",method:"POST",
   auth:{headerName:"x-goog-api-key",credentialSource:"server-only"},
   policy:{provider:"google",model:MODEL,requiresApproval:true},
   payload
  });
 }

 async function assertConnection(){
  if(env.GOOGLE_OMNI_CONNECTION_STATUS!=="connected")throw fail("Google Omni connection has not been marked connected by the operator.","GOOGLE_OMNI_CONNECTION_REQUIRED");
  const key=text(env.GEMINI_API_KEY||env.GOOGLE_GEMINI_API_KEY);
  if(!key)throw fail("Gemini API key is not configured on the worker.","GOOGLE_OMNI_CONNECTION_REQUIRED");
  if(connectionCache&&now()-connectionCache.checkedAt<connectionCacheMs)return connectionCache.result;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
   const response=await fetchImpl(ORIGIN+"/v1beta/models/"+MODEL,{
    method:"GET",headers:{"x-goog-api-key":key,accept:"application/json"},
    signal:controller.signal,redirect:"error"
   });
   const raw=await response.text();
   if(Buffer.byteLength(raw)>128*1024)throw fail("Google model metadata response exceeded its size limit.","GOOGLE_OMNI_CONNECTION_INVALID");
   let data=null;try{data=JSON.parse(raw);}catch{throw fail("Google model metadata response was invalid.","GOOGLE_OMNI_CONNECTION_INVALID");}
   if(!response.ok||data?.name!=="models/"+MODEL)throw fail("Google Omni model access could not be verified.","GOOGLE_OMNI_CONNECTION_REQUIRED");
   const result=Object.freeze({connected:true,verified:true,connectionId:"gemini-key:"+createHash("sha256").update(key).digest("hex").slice(0,16)});
   connectionCache={checkedAt:now(),result};return result;
  }catch(error){if(error?.name==="AbortError")throw fail("Google Omni connection verification timed out.","GOOGLE_OMNI_CONNECTION_REQUIRED");throw error;}
  finally{clearTimeout(timer);}
 }

 return Object.freeze({assertApprovedSubmission,authorizeInteraction,preparePlan,assertConnection});
}
