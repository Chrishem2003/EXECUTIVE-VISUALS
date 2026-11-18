import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { resolve, relative, sep } from "node:path";
import { getAccessibleAsset, json, parseJson } from "./db.mjs";
import { storeGeneratedVideoFromStream } from "./generated-assets.mjs";
import { verifyC2paAsset as verifyC2paAssetDefault } from "./c2pa-verification.mjs";
import { createVideoWorkflowCloudRequest } from "./video-workflow-cloud-contract.mjs";
import { createVideoRequestProvenance } from "./video-generation-contract.mjs";
import { executableAvailable, run as runMediaProcess, validateMediaOutputProbe } from "./media.mjs";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_VIDEO_BYTES=250*1024*1024;
const fail=(message,code)=>Object.assign(new Error(message),{code});
function safeAssetPath(mediaRoot,asset){
 const root=resolve(mediaRoot),absolute=resolve(root,String(asset.storage_path||""));
 const stored=relative(root,absolute);
 if(!stored||stored===".."||stored.startsWith(".."+sep)||absolute===root)throw fail("Workflow source asset path failed validation.","ASSET_PATH_INVALID");
 return absolute;
}

async function verifyLocalAssetFile(filePath,asset){
 const expectedSize=Number(asset.byte_size),expectedHash=String(asset.sha256||"");
 if(!Number.isSafeInteger(expectedSize)||expectedSize<1||expectedSize>MAX_VIDEO_BYTES||!/^[a-f0-9]{64}$/.test(expectedHash)){
  throw fail("Workflow source asset size or checksum metadata is invalid.","VIDEO_WORKFLOW_INPUT_ASSET_CHECKSUM_MISMATCH");
 }
 const hash=createHash("sha256");let size=0;
 try{
  for await(const chunk of createReadStream(filePath)){
   size+=chunk.length;
   if(size>MAX_VIDEO_BYTES||size>expectedSize)throw fail("Workflow source asset changed or exceeded its recorded size.","VIDEO_WORKFLOW_INPUT_ASSET_CHECKSUM_MISMATCH");
   hash.update(chunk);
  }
 }catch(error){
  if(String(error?.code||"").startsWith("VIDEO_WORKFLOW_"))throw error;
  throw fail("Workflow source asset could not be read for integrity verification.","VIDEO_WORKFLOW_INPUT_ASSET_UNAVAILABLE");
 }
 if(size!==expectedSize||hash.digest("hex")!==expectedHash){
  throw fail("A workflow input asset changed or failed checksum verification.","VIDEO_WORKFLOW_INPUT_ASSET_CHECKSUM_MISMATCH");
 }
 return expectedSize;
}
function createVerifiedAssetUploadStream(filePath,asset){
 const expectedSize=Number(asset.byte_size),expectedHash=String(asset.sha256||"");
 const hash=createHash("sha256");let size=0;
 const source=createReadStream(filePath);
 const verifier=new Transform({
  transform(chunk,encoding,callback){
   size+=chunk.length;
   if(size>MAX_VIDEO_BYTES||size>expectedSize){callback(fail("Workflow source asset changed or exceeded its recorded size.","VIDEO_WORKFLOW_INPUT_ASSET_CHECKSUM_MISMATCH"));return;}
   hash.update(chunk);callback(null,chunk);
  },
  flush(callback){
   if(size!==expectedSize||hash.digest("hex")!==expectedHash){callback(fail("Workflow source asset changed during private cloud upload.","VIDEO_WORKFLOW_INPUT_ASSET_CHECKSUM_MISMATCH"));return;}
   callback();
  }
 });
 source.on("error",error=>verifier.destroy(error));
 verifier.on("error",()=>source.destroy());
 source.pipe(verifier);
 verifier.headers={"content-length":String(expectedSize)};
 return verifier;
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
async function probeLocalMedia(filePath){
 if(!executableAvailable("ffprobe"))throw fail("FFprobe is required to validate cloud video workflow source media.","MEDIA_ENGINE_MISSING");
 const result=await runMediaProcess("ffprobe",["-v","error","-show_format","-show_streams","-of","json",filePath],15000);
 try{return JSON.parse(result.stdout);}catch{throw fail("Workflow source media probe returned invalid metadata.","VIDEO_WORKFLOW_INPUT_MEDIA_INVALID");}
}

/**
 * Executes a workflow video.generate node through the governed cloud queue.
 * Inputs are copied to the private cloud workspace by verified checksum;
 * provider submission, budget reservation and settlement remain worker-only.
 */
export async function executeCloudVideoWorkflowNode({
 db,job,run,node,values={},mediaRoot,cloudTimelineApi,
 onProgress=()=>{},onJobEnqueued=()=>{},onApprovalRequired=()=>{},fetchImpl=globalThis.fetch,probeMedia=probeLocalMedia,verifyC2paAsset=verifyC2paAssetDefault,
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
  initial.input.sourceVideoAssetId,initial.input.startFrameAssetId,initial.input.endFrameAssetId,
  ...(initial.input.keyframeAssetIds||[]),
  ...(initial.input.referenceAssetIds||[]),...(initial.input.referenceImageAssetIds||[]),
  ...(initial.input.referenceVideoAssetIds||[]),...(initial.input.referenceAudioAssetIds||[])
 ].filter(Boolean))];
 if(localIds.length&&node.config?.rightsConfirmed!==true)throw fail("Confirm that you have the rights to use every connected source/reference asset before cloud video generation.","MEDIA_RIGHTS_REQUIRED");
 const mapping=new Map();
 for(const localAssetId of localIds){
  const local=getAccessibleAsset(db,job.owner_id,localAssetId,false);
  if(!local||local.project_id&&local.project_id!==projectId)throw fail("A workflow reference asset is missing, inaccessible or belongs to another project.","VIDEO_WORKFLOW_INPUT_ASSET_FORBIDDEN");
  if(!["image/","video/","audio/"].some(prefix=>String(local.media_type||"").startsWith(prefix)))throw fail("Cloud video workflow inputs must be image, video or audio assets.","VIDEO_WORKFLOW_INPUT_ASSET_UNSUPPORTED");
  const absolute=safeAssetPath(mediaRoot,local);
  await verifyLocalAssetFile(absolute,local);
  if(String(local.media_type||"").startsWith("video/")){
   let mediaProbe;
   try{mediaProbe=await probeMedia(absolute);validateMediaOutputProbe(mediaProbe,local.media_type);}
   catch(error){if(error?.code==="MEDIA_ENGINE_MISSING")throw error;throw fail("Workflow video input must contain a verifiable video stream and positive duration.", "VIDEO_WORKFLOW_INPUT_MEDIA_INVALID");}
  }
  const metadata=parseJson(local.metadata_json,{});
  let cloudAssetId=metadata?.cloudWorkspace?.assetId||"";
  if(cloudAssetId){
   const existing=await cloudTimelineApi.handle({method:"GET",path:"/api/cloud/assets/"+cloudAssetId,ownerId:job.owner_id});
   if(existing?.status!==200||existing.body?.asset?.sha256!==local.sha256||existing.body?.asset?.projectId!==projectId)cloudAssetId="";
  }
  if(!cloudAssetId){
   const stream=createVerifiedAssetUploadStream(absolute,local);
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
   quoteId,requestId,requestHash:cloudRequest.requestHash,
   provider:String(quote.body.quote.provider||cloudRequest.provider),
   model:String(quote.body.quote.model||cloudRequest.model),
   operation:String(quote.body.quote.operation||cloudRequest.operation),
   routedProvider:String(quote.body.quote.routedProvider||""),
   routedModel,configId:String(quote.body.quote.configId||""),
   estimatedCredits:Number(quote.body.quote.estimatedCredits||0),
   estimatedAmount:Number(quote.body.quote.estimatedAmount),currency:String(quote.body.quote.currency||"USD"),
   pricingSource:String(quote.body.quote.pricingSource||""),
   pricingUrl:String(quote.body.quote.pricingUrl||""),
   expiresAt:String(quote.body.quote.expiresAt||""),paidExecutionEnabled:quote.body.quote.paidExecutionEnabled===true,
   cloudNode,cloudValues
  };
  onApprovalRequired(receipt);
  return {awaitingApproval:true,...receipt};
 }

 while(true){
  const localJob=db.prepare("SELECT status,lease_owner,lease_expires_at,lease_token FROM jobs WHERE id=?").get(job.id);
  if(localJob?.status==="cancelled"){
   await cloudTimelineApi.handle({method:"POST",path:"/api/cloud/jobs/"+cloudJobId+"/cancel",ownerId:job.owner_id,body:{}});
   throw fail("Workflow was cancelled while cloud video generation was running.","WORKFLOW_CANCELLED");
  }
  const leaseExpiresAt=Date.parse(String(localJob?.lease_expires_at||""));
  if(localJob?.status!=="running"||localJob.lease_owner!==job.lease_owner||!UUID.test(String(job.lease_token||""))||localJob.lease_token!==job.lease_token||!Number.isFinite(leaseExpiresAt)||leaseExpiresAt<=Date.now()){
   throw fail("Workflow worker lease changed or expired while awaiting the cloud video job.","WORKFLOW_WORKER_LEASE_LOST");
  }
  const status=await cloudTimelineApi.handle({method:"GET",path:"/api/cloud/jobs/"+cloudJobId,ownerId:job.owner_id});
  if(status?.status!==200)throw cloudResultError(status,"VIDEO_WORKFLOW_JOB_STATUS_UNAVAILABLE");
  const cloudJob=status.body?.job;
  if(!cloudJob||cloudJob.id!==cloudJobId)throw fail("Cloud job status response did not match the approved job.","VIDEO_WORKFLOW_JOB_STATUS_INVALID");
  const approvedInput=cloudJob.input||{};
  if(cloudJob.owner_id!==job.owner_id||cloudJob.project_id!==projectId||cloudJob.job_type!=="video.generate"||
     approvedInput.workflowQuoteId!==quoteId||approvedInput.workflowRequestId!==requestId||
     approvedInput.requestHash!==cloudRequest.requestHash||
     approvedInput.approvedMaxAmount!==approvedMaxAmount){
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
   const provider=String(cloudJob.output?.provider||cloudRequest.provider||initial.provider);
   const model=String(cloudJob.output?.model||routedModel||cloudRequest.model);
   const adapterVersion=provider==="google"?"google-gemini-omni-cloud-worker-v1":"runway-model-router-cloud-worker-v1";
   let actualDurationSeconds=null;
   const imported=[];
   const assetProvenance=[];
   async function verifyAndPersistC2pa(assetRecord){
    let verification;
    try{
     const filePath=safeAssetPath(mediaRoot,{storage_path:assetRecord.storage_path});
     verification=await verifyC2paAsset({filePath,mediaType:assetRecord.media_type||"video/mp4",expectedSha256:String(assetRecord.sha256||""),expectedSize:Number(assetRecord.byte_size)});
    }catch(error){
     verification={status:"validation_unavailable",present:null,valid:false,trusted:false,validationState:null,findings:[String(error?.code||"C2PA_VERIFICATION_ERROR").slice(0,160)]};
    }
    const summary={
     status:["trusted","valid_untrusted","invalid","not_present","validation_unavailable"].includes(verification?.status)?verification.status:"validation_unavailable",
     present:typeof verification?.present==="boolean"?verification.present:null,
     valid:verification?.valid===true,
     trusted:verification?.status==="trusted"&&verification?.trusted===true,
     validationState:typeof verification?.validationState==="string"?verification.validationState:null,
     findings:Array.isArray(verification?.findings)?verification.findings.filter(item=>typeof item==="string").slice(0,20):[]
    };
    const metadata={...parseJson(assetRecord.metadata_json,{}),c2paVerification:summary};
    db.prepare("UPDATE assets SET metadata_json=? WHERE id=? AND owner_id=? AND project_id=?")
     .run(json(metadata),assetRecord.id,job.owner_id,projectId);
    assetProvenance.push({assetId:assetRecord.id,...summary});
    return summary;
   }
   for(const cloudAssetId of cloudAssetIds){
    if(!UUID.test(String(cloudAssetId)))throw fail("Cloud video output contains an invalid asset ID.","VIDEO_WORKFLOW_OUTPUT_INVALID");
    const existing=db.prepare("SELECT id,metadata_json,storage_path,byte_size,sha256,media_type FROM assets WHERE owner_id=? AND project_id=? AND deleted_at IS NULL AND metadata_json LIKE ? LIMIT 1")
     .get(job.owner_id,projectId,"%\\\"cloudWorkspaceAssetId\\\":\\\""+cloudAssetId+"\\\"%");
    if(existing){
     imported.push(existing.id);
     const metadata=parseJson(existing.metadata_json,{});
     if(metadata.c2paVerification&&typeof metadata.c2paVerification==="object")assetProvenance.push({assetId:existing.id,...metadata.c2paVerification});
     else await verifyAndPersistC2pa(existing);
     continue;
    }
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
    const declaredSize=Number(response.headers?.get?.("content-length")||0);
    if(declaredSize&&declaredSize!==asset.size){
     await response.body?.cancel?.().catch(()=>{});
     throw fail("Private cloud output Content-Length does not match its verified asset metadata.","VIDEO_WORKFLOW_OUTPUT_CHECKSUM_MISMATCH");
    }
    if(!response.body||typeof response.body.getReader!=="function")throw fail("Private cloud output did not provide a readable response stream.","VIDEO_WORKFLOW_OUTPUT_DOWNLOAD_FAILED");
    if(actualDurationSeconds===null){
     const reportedDuration=Number(asset.metadata?.durationSeconds||asset.metadata?.duration||0);
     if(Number.isFinite(reportedDuration)&&reportedDuration>0)actualDurationSeconds=reportedDuration;
    }
    const provenance=createVideoRequestProvenance(initial.input,{provider,model,adapterVersion});
    const local=await storeGeneratedVideoFromStream({db,mediaRoot,ownerId:job.owner_id,projectId,jobId:job.id,prompt:initial.input.prompt,model,provenance,cloudWorkspaceAssetId:cloudAssetId,cloudVideoJobId:cloudJobId,cloudSha256:asset.sha256,stream:Readable.fromWeb(response.body),expectedSize:asset.size,expectedSha256:asset.sha256});
    imported.push(local.id);
    await verifyAndPersistC2pa({id:local.id,metadata_json:json(local.metadata),storage_path:local.storagePath,byte_size:local.size,sha256:local.sha256,media_type:local.mediaType});
   }
   const output={asset:imported[0],assetId:imported[0],video:imported[0],assetIds:imported,assets:imported,assetProvenance,cloudAssetIds:[...cloudAssetIds],
    durationSeconds:provider==="google"?actualDurationSeconds:Number(initial.input.durationSeconds),
    provider,model,
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
