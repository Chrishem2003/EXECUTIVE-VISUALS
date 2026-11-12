import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { resolve, relative, sep } from "node:path";
import { getAccessibleAsset, json, parseJson } from "./db.mjs";
import { storeGeneratedVideo } from "./generated-assets.mjs";
import { createVideoWorkflowCloudRequest } from "./video-workflow-cloud-contract.mjs";
import { createVideoRequestProvenance } from "./video-generation-contract.mjs";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_VIDEO_BYTES=250*1024*1024;
const fail=(message,code)=>Object.assign(new Error(message),{code});
function safeAssetPath(mediaRoot,asset){
 const root=resolve(mediaRoot),absolute=resolve(root,String(asset.storage_path||""));
 const stored=relative(root,absolute);
 if(!stored||stored===".."||stored.startsWith(".."+sep)||absolute===root)throw fail("Workflow source asset path failed validation.","ASSET_PATH_INVALID");
 return absolute;
}
function replaceAssetReferences(value,mapping){
 if(typeof value==="string")return mapping.get(value)||value;
 if(Array.isArray(value))return value.map(item=>replaceAssetReferences(item,mapping));
 if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,replaceAssetReferences(item,mapping)]));
 return value;
}
function cloudResultError(result,fallback){
 const code=result?.body?.error?.code||fallback;
 return fail(result?.body?.error?.message||"Cloud workflow request failed.",code);
}
async function readBounded(response,maximum){
 const declared=Number(response.headers?.get?.("content-length")||0);
 if(declared>maximum)throw fail("Cloud video output exceeds the local import limit.","VIDEO_OUTPUT_TOO_LARGE");
 if(!response.body?.getReader){
  const buffer=Buffer.from(await response.arrayBuffer());
  if(buffer.length>maximum)throw fail("Cloud video output exceeds the local import limit.","VIDEO_OUTPUT_TOO_LARGE");
  return buffer;
 }
 const reader=response.body.getReader(),chunks=[];let total=0;
 try{
  while(true){
   const {done,value}=await reader.read();if(done)break;
   total+=value.byteLength;
   if(total>maximum){await reader.cancel().catch(()=>{});throw fail("Cloud video output exceeds the local import limit.","VIDEO_OUTPUT_TOO_LARGE");}
   chunks.push(Buffer.from(value));
  }
 }finally{reader.releaseLock();}
 return Buffer.concat(chunks,total);
}

/**
 * Executes a workflow video.generate node through the governed cloud queue.
 * Inputs are copied to the private cloud workspace by verified checksum;
 * provider submission, budget reservation and settlement remain worker-only.
 */
export async function executeCloudVideoWorkflowNode({
 db,job,run,node,values={},mediaRoot,cloudTimelineApi,
 onProgress=()=>{},onJobEnqueued=()=>{},onApprovalRequired=()=>{},fetchImpl=globalThis.fetch,
 pollIntervalMs=5000,waitForCompletion=false
}={}){
 if(!cloudTimelineApi||typeof cloudTimelineApi.handle!=="function"||typeof cloudTimelineApi.uploadAsset!=="function"){
  throw fail("The authenticated cloud workspace is not enabled for this workflow.","VIDEO_WORKFLOW_CLOUD_DISABLED");
 }
 const projectId=String(job.project_id||run?.project_id||"");
 if(!UUID.test(projectId))throw fail("Cloud video workflow execution requires a saved UUID project.","VIDEO_WORKFLOW_CLOUD_PROJECT_REQUIRED");
 if(!Number.isInteger(pollIntervalMs)||pollIntervalMs<5000||pollIntervalMs>60000||typeof waitForCompletion!=="boolean"){
  throw fail("Cloud workflow polling limits are invalid.","VIDEO_WORKFLOW_CLOUD_CONFIG_INVALID");
 }
 const project=db.prepare("SELECT id,owner_id,name,description FROM projects WHERE id=?").get(projectId);
 if(!project)throw fail("The local workflow project no longer exists.","VIDEO_WORKFLOW_CLOUD_PROJECT_REQUIRED");
 let linked=await cloudTimelineApi.handle({method:"GET",path:"/api/cloud/projects/"+projectId,ownerId:job.owner_id});
 if(linked?.status!==200){
  if(project.owner_id!==job.owner_id)throw fail("The project owner must link this shared project to the cloud workspace before editors can run cloud video nodes.","VIDEO_WORKFLOW_CLOUD_PROJECT_NOT_LINKED");
  linked=await cloudTimelineApi.handle({method:"POST",path:"/api/cloud/projects",ownerId:job.owner_id,body:{projectId,name:project.name,description:project.description||""}});
  if(!linked||![200,201].includes(linked.status))throw cloudResultError(linked,"VIDEO_WORKFLOW_CLOUD_PROJECT_LINK_FAILED");
 }

 const initial=createVideoWorkflowCloudRequest({node,values,projectId,requestId:"workflow-"+createHash("sha256").update(String(run.id)+":"+String(node.id)).digest("hex")});
 const localIds=[...new Set([
  initial.input.sourceVideoAssetId,initial.input.startFrameAssetId,
  ...(initial.input.referenceAssetIds||[]),...(initial.input.referenceVideoAssetIds||[]),
  ...(initial.input.referenceAudioAssetIds||[])
 ].filter(Boolean))];
 if(localIds.length&&node.config?.rightsConfirmed!==true)throw fail("Confirm that you have the rights to use every connected source/reference asset before cloud video generation.","MEDIA_RIGHTS_REQUIRED");
 const mapping=new Map();
 for(const localAssetId of localIds){
  const local=getAccessibleAsset(db,job.owner_id,localAssetId,false);
  if(!local||local.project_id&&local.project_id!==projectId)throw fail("A workflow reference asset is missing, inaccessible or belongs to another project.","VIDEO_WORKFLOW_INPUT_ASSET_FORBIDDEN");
  if(!["image/","video/","audio/"].some(prefix=>String(local.media_type||"").startsWith(prefix)))throw fail("Cloud video workflow inputs must be image, video or audio assets.","VIDEO_WORKFLOW_INPUT_ASSET_UNSUPPORTED");
  const absolute=safeAssetPath(mediaRoot,local),buffer=await readFile(absolute);
  if(buffer.length<1||buffer.length>MAX_VIDEO_BYTES||buffer.length!==Number(local.byte_size)||
     createHash("sha256").update(buffer).digest("hex")!==local.sha256){
   throw fail("A workflow input asset changed or failed checksum verification.","VIDEO_WORKFLOW_INPUT_ASSET_CHECKSUM_MISMATCH");
  }
  const metadata=parseJson(local.metadata_json,{});
  let cloudAssetId=metadata?.cloudWorkspace?.assetId||"";
  if(cloudAssetId){
   const existing=await cloudTimelineApi.handle({method:"GET",path:"/api/cloud/assets/"+cloudAssetId,ownerId:job.owner_id});
   if(existing?.status!==200||existing.body?.asset?.sha256!==local.sha256||existing.body?.asset?.projectId!==projectId)cloudAssetId="";
  }
  if(!cloudAssetId){
   const stream=Readable.from([buffer]);stream.headers={"content-length":String(buffer.length)};
   const uploaded=await cloudTimelineApi.uploadAsset({req:stream,ownerId:job.owner_id,projectId,originalName:local.original_name,mediaType:local.media_type});
   if(uploaded?.status!==201||!UUID.test(String(uploaded.body?.asset?.id||""))||
      uploaded.body.asset.sha256!==local.sha256||uploaded.body.asset.projectId!==projectId){
    throw cloudResultError(uploaded,"VIDEO_WORKFLOW_INPUT_ASSET_UPLOAD_FAILED");
   }
   cloudAssetId=uploaded.body.asset.id;
   db.prepare("UPDATE assets SET metadata_json=? WHERE id=? AND owner_id=?")
    .run(json({...metadata,cloudWorkspace:{assetId:cloudAssetId,projectId,sha256:local.sha256}}),local.id,local.owner_id);
  }
  mapping.set(localAssetId,cloudAssetId);
 }
 const cloudNode=replaceAssetReferences(node,mapping);
 const cloudValues=replaceAssetReferences(values,mapping);
 const requestId=initial.requestId;
 const cloudRequest=createVideoWorkflowCloudRequest({node:cloudNode,values:cloudValues,projectId,requestId});
 const priorNode=db.prepare("SELECT output_json FROM workflow_node_runs WHERE run_id=? AND node_id=?").get(run.id,node.id);
 const priorOutput=parseJson(priorNode?.output_json,{});
 let cloudJobId=String(priorOutput.cloudJobId||"");
 let quoteId=String(priorOutput.quoteId||"");
 let routedModel=String(priorOutput.routedModel||"");
 let approvedMaxAmount=Number(priorOutput.approvedMaxAmount);
 if(cloudJobId){
  if(!UUID.test(cloudJobId)||!UUID.test(quoteId)||!Number.isFinite(approvedMaxAmount)||approvedMaxAmount<=0||
     priorOutput.requestId!==requestId||priorOutput.requestHash!==cloudRequest.requestHash){
   throw fail("Persisted cloud workflow approval does not match the current immutable node request.","VIDEO_WORKFLOW_JOB_RECEIPT_INVALID");
  }
 }else{
  const quote=await cloudTimelineApi.handle({method:"POST",path:"/api/cloud/workflows/video/quote",ownerId:job.owner_id,body:{projectId,node:cloudNode,values:cloudValues,requestId}});
  if(quote?.status!==200)throw cloudResultError(quote,"VIDEO_WORKFLOW_QUOTE_FAILED");
  if(quote.body?.quote?.billable!==false||quote.body?.quote?.requiresExplicitApproval!==true)throw fail("Cloud quote did not prove a non-billable estimate requiring explicit approval.","VIDEO_WORKFLOW_QUOTE_INVALID");
  quoteId=String(quote.body.quote.id||"");
  routedModel=String(quote.body.quote.routedModel||"");
  if(!UUID.test(quoteId)||quote.body.quote.requestId!==requestId||
     quote.body.quote.requestHash!==cloudRequest.requestHash||
     !Number.isFinite(Number(quote.body.quote.estimatedAmount))||Number(quote.body.quote.estimatedAmount)<=0){
   throw fail("Cloud quote does not match the immutable workflow node request.","VIDEO_WORKFLOW_QUOTE_INVALID");
  }
  const receipt={
   quoteId,requestId,requestHash:cloudRequest.requestHash,routedModel,
   estimatedAmount:Number(quote.body.quote.estimatedAmount),currency:String(quote.body.quote.currency||"USD"),
   expiresAt:String(quote.body.quote.expiresAt||""),paidExecutionEnabled:quote.body.quote.paidExecutionEnabled===true,
   cloudNode,cloudValues
  };
  onApprovalRequired(receipt);
  return {awaitingApproval:true,...receipt};
 }

 while(true){
  const localJob=db.prepare("SELECT status,lease_owner,lease_expires_at FROM jobs WHERE id=?").get(job.id);
  if(localJob?.status==="cancelled"){
   await cloudTimelineApi.handle({method:"POST",path:"/api/cloud/jobs/"+cloudJobId+"/cancel",ownerId:job.owner_id,body:{}});
   throw fail("Workflow was cancelled while cloud video generation was running.","WORKFLOW_CANCELLED");
  }
  if(localJob?.status!=="running"||localJob.lease_owner!==job.lease_owner){
   throw fail("Workflow worker lease changed while awaiting the cloud video job.","WORKFLOW_WORKER_LEASE_LOST");
  }
  const status=await cloudTimelineApi.handle({method:"GET",path:"/api/cloud/jobs/"+cloudJobId,ownerId:job.owner_id});
  if(status?.status!==200)throw cloudResultError(status,"VIDEO_WORKFLOW_JOB_STATUS_UNAVAILABLE");
  const cloudJob=status.body?.job;
  if(!cloudJob||cloudJob.id!==cloudJobId)throw fail("Cloud job status response did not match the approved job.","VIDEO_WORKFLOW_JOB_STATUS_INVALID");
  const approvedInput=cloudJob.input||{};
  if(cloudJob.owner_id!==job.owner_id||cloudJob.project_id!==projectId||cloudJob.job_type!=="video.generate"||
     approvedInput.workflowQuoteId!==quoteId||approvedInput.workflowRequestId!==requestId||
     approvedInput.requestHash!==cloudRequest.requestHash){
   throw fail("Cloud job receipt does not match the owner, project and exact approved workflow quote.","VIDEO_WORKFLOW_JOB_RECEIPT_MISMATCH");
  }
  if(cloudJob.status==="succeeded") {
   const actualAmount=Number(cloudJob.output?.actualAmount);
   const actualCurrency=String(cloudJob.output?.currency||"");
   const costEvidenceReference=String(cloudJob.output?.costEvidenceReference||"");
   if(!Number.isFinite(actualAmount)||actualAmount<0||actualCurrency!=="USD"||!costEvidenceReference||costEvidenceReference.length>1000){
    throw fail("The completed cloud video job is missing authoritative actual-cost and settlement evidence.","VIDEO_WORKFLOW_ACTUAL_COST_EVIDENCE_MISSING");
   }
   const cloudAssetIds=cloudJob.output?.assetIds;
   if(!Array.isArray(cloudAssetIds)||cloudAssetIds.length<1||cloudAssetIds.length>10)throw fail("Cloud video job completed without a valid private asset collection.","VIDEO_WORKFLOW_OUTPUT_INVALID");
   const imported=[];
   for(const cloudAssetId of cloudAssetIds){
    if(!UUID.test(String(cloudAssetId)))throw fail("Cloud video output contains an invalid asset ID.","VIDEO_WORKFLOW_OUTPUT_INVALID");
    const existing=db.prepare("SELECT id,metadata_json FROM assets WHERE owner_id=? AND project_id=? AND deleted_at IS NULL AND metadata_json LIKE ? LIMIT 1")
     .get(job.owner_id,projectId,"%\"cloudWorkspaceAssetId\":\""+cloudAssetId+"\"%");
    if(existing){imported.push(existing.id);continue;}
    const signed=await cloudTimelineApi.handle({method:"GET",path:"/api/cloud/assets/"+cloudAssetId,ownerId:job.owner_id});
    if(signed?.status!==200)throw cloudResultError(signed,"VIDEO_WORKFLOW_OUTPUT_ASSET_UNAVAILABLE");
    const asset=signed.body?.asset,url=signed.body?.url;
    if(!asset||asset.id!==cloudAssetId||asset.projectId!==projectId||asset.mediaType!=="video/mp4"||
       !Number.isSafeInteger(asset.size)||asset.size<12||asset.size>MAX_VIDEO_BYTES||
       typeof asset.sha256!=="string"||!/^[a-f0-9]{64}$/.test(asset.sha256)||typeof url!=="string"){
     throw fail("Cloud output asset metadata failed scope, type or checksum validation.","VIDEO_WORKFLOW_OUTPUT_ASSET_INVALID");
    }
    const signedUrl=new URL(url),trustedOrigin=new URL(process.env.SUPABASE_URL||"").origin;
    if(signedUrl.protocol!=="https:"||signedUrl.origin!==trustedOrigin)throw fail("Cloud output signed URL is outside the configured Supabase origin.","VIDEO_WORKFLOW_OUTPUT_URL_REJECTED");
    const response=await fetchImpl(signedUrl,{redirect:"error"});
    if(!response.ok)throw fail("Private cloud output download failed (HTTP "+response.status+").","VIDEO_WORKFLOW_OUTPUT_DOWNLOAD_FAILED");
    const buffer=await readBounded(response,MAX_VIDEO_BYTES);
    if(buffer.length!==asset.size||createHash("sha256").update(buffer).digest("hex")!==asset.sha256)throw fail("Downloaded cloud output failed byte-size or SHA-256 verification.","VIDEO_WORKFLOW_OUTPUT_CHECKSUM_MISMATCH");
    const provenance=createVideoRequestProvenance(initial.input,{provider:"runway",model:cloudJob.output?.model||routedModel||"model-router",adapterVersion:"runway-model-router-cloud-worker-v1"});
    const local=await storeGeneratedVideo({db,mediaRoot,ownerId:job.owner_id,projectId,jobId:job.id,prompt:initial.input.prompt,model:cloudJob.output?.model||routedModel||"model-router",provenance,cloudWorkspaceAssetId:cloudAssetId,cloudVideoJobId:cloudJobId,cloudSha256:asset.sha256,buffer});
    imported.push(local.id);
   }
   const output={asset:imported[0],assetId:imported[0],video:imported[0],assetIds:imported,assets:imported,
    provider:"runway",model:cloudJob.output?.model||routedModel||"model-router",
    cloudJobId,usage:cloudJob.output?.usage||null,quoteId,
    approvedMaxAmount,actualAmount,currency:actualCurrency,costEvidenceReference};
   onProgress(95);
   return output;
  }
  if(["failed","needs_input","cancelled","canceled"].includes(String(cloudJob.status))){
   const detail=cloudJob.error||{};
   throw fail(String(detail.message||"Cloud video job ended with status "+cloudJob.status).slice(0,500),
    cloudJob.status==="needs_input"?"VIDEO_WORKFLOW_CLOUD_JOB_NEEDS_INPUT":"VIDEO_WORKFLOW_CLOUD_JOB_FAILED");
  }
  if(!waitForCompletion)return {pending:true,cloudJobId,quoteId,requestId,requestHash:cloudRequest.requestHash,routedModel,approvedMaxAmount,status:cloudJob.status};
  onProgress(cloudJob.status==="running"?80:72);
  await new Promise(resolve=>setTimeout(resolve,pollIntervalMs));
 }
}
