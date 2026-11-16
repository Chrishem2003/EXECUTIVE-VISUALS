import { buildMediaOperationArgs, buildProxyVideoArgs, buildAudioMasterAnalysisArgs } from "./media.mjs";

const OPTIONS=Object.freeze({
 "media.color":["brightness","contrast","saturation"],
 "media.denoise":["luma","chroma"],
 "media.resize":["width","height","fit"],
 "media.interpolate":["fps"],
 "media.proxy":["proxyWidth","proxyCrf"],
 "media.audio_extract":[],
 "media.audio-master":["targetLufs","targetLra","truePeakDbtp"]
});
const fail=(message,code="INVALID_MEDIA_BATCH",status=400)=>Object.assign(new Error(message),{code,status});
const plain=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);

/** Validate a batch of deterministic FFmpeg operations before any queue write. */
export function normalizeMediaBatchRequest({ownerId,projectId=null,jobType,options={},items,getAsset,canWriteProject}={}){
 if(typeof ownerId!=="string"||!ownerId.trim())throw fail("Authentication is required.","AUTH_REQUIRED",401);
 if(!Object.hasOwn(OPTIONS,String(jobType)))throw fail("Choose a supported deterministic media operation.","MEDIA_BATCH_OPERATION_UNSUPPORTED");
 if(!plain(options))throw fail("Media batch options must be an object.");
 if(!Array.isArray(items)||items.length<1||items.length>50)throw fail("Select between 1 and 50 source media assets for a batch.","INVALID_MEDIA_BATCH_SIZE");
 if(typeof getAsset!=="function"||typeof canWriteProject!=="function")throw new TypeError("Media batch authorization dependencies are required.");
 const allowed=new Set(OPTIONS[jobType]);
 if(Object.keys(options).some(key=>!allowed.has(key)))throw fail("Media batch contains an unsupported operation option.","MEDIA_BATCH_OPTION_UNSUPPORTED");
 const normalizedOptions={};
 for(const [key,value] of Object.entries(options)){
  if(key==="fit"){
   if(value!=="contain"&&value!=="cover")throw fail("Resize fit must be contain or cover.","INVALID_MEDIA_OPTIONS");
   normalizedOptions[key]=value;
  }else{
   const number=Number(value);
   if(!Number.isFinite(number))throw fail("Media batch numeric options must be finite numbers.","INVALID_MEDIA_OPTIONS");
   normalizedOptions[key]=number;
  }
 }
 const defaults={
  "media.color":{brightness:0,contrast:1,saturation:1},
  "media.denoise":{luma:4,chroma:3},
  "media.resize":{width:1920,height:1080,fit:"contain"},
  "media.interpolate":{fps:30},
  "media.proxy":{proxyWidth:960,proxyCrf:28},
  "media.audio_extract":{},
  "media.audio-master":{targetLufs:-16,targetLra:11,truePeakDbtp:-1.5}
 };
 const operationOptions={...defaults[jobType],...normalizedOptions};
 if(jobType==="media.proxy"&&(!Number.isInteger(operationOptions.proxyWidth)||operationOptions.proxyWidth<320||operationOptions.proxyWidth>1920||!Number.isInteger(operationOptions.proxyCrf)||operationOptions.proxyCrf<18||operationOptions.proxyCrf>35))throw fail("Proxy width must be 320–1920 and CRF must be 18–35.","INVALID_MEDIA_OPTIONS");
 try{
  if(jobType==="media.proxy")buildProxyVideoArgs({sourcePath:"/tmp/ev-batch-source.mp4",outputPath:"/tmp/ev-batch-proxy.mp4",input:operationOptions});
  else if(jobType==="media.audio-master")buildAudioMasterAnalysisArgs({sourcePath:"/tmp/ev-batch-source.wav",input:operationOptions});
  else if(jobType!=="media.audio_extract")buildMediaOperationArgs({jobType,input:operationOptions,sourcePath:"/tmp/ev-batch-source.mp4",outputPath:"/tmp/ev-batch-output.mp4"});
 }catch(error){throw fail(error.message||"Media batch options are invalid.",error.code||"INVALID_MEDIA_OPTIONS");}
 let selectedProject=projectId==null||projectId===""?null:String(projectId);
 const seen=new Set(),normalizedItems=[];
 for(const item of items){
  if(!plain(item))throw fail("Every media batch item must be an object.","INVALID_MEDIA_BATCH_ITEM");
  const sourceAssetId=String(item.sourceAssetId||"").trim();
  if(!sourceAssetId||sourceAssetId.length>160||seen.has(sourceAssetId))throw fail("Each batch item needs a unique sourceAssetId.","INVALID_MEDIA_BATCH_ITEM");
  seen.add(sourceAssetId);
  const source=getAsset(sourceAssetId);
  if(!source)throw fail("Every source video must be accessible and editable.","SOURCE_ASSET_NOT_FOUND",404);
  const mediaType=String(source.media_type||source.mediaType||"");
  const expectedType=jobType==="media.audio-master"?"audio/":"video/";
  if(!mediaType.startsWith(expectedType))throw fail(jobType==="media.audio-master"?"Audio mastering batches require audio source assets.":"This batch operation requires video source assets.","UNSUPPORTED_MEDIA_TYPE",415);
  const sourceProjectId=source.project_id??source.projectId??null;
  if(normalizedItems.length===0&&selectedProject===null)selectedProject=sourceProjectId;
  if(sourceProjectId!==selectedProject)throw fail("All batch videos must belong to the same selected project or private workspace.","PROJECT_MISMATCH");
  normalizedItems.push({sourceAssetId,options:{...operationOptions}});
 }
 if(selectedProject&&!canWriteProject(ownerId,selectedProject))throw fail("Project not found or editor access required.","PROJECT_NOT_FOUND",404);
 return Object.freeze({projectId:selectedProject,jobType,items:normalizedItems});
}

/** Compare an existing per-item idempotency set with the exact requested batch. */
export function inspectMediaBatchReplay(existingJobs,items,projectId,jobType){
 if(!Array.isArray(existingJobs)||!Array.isArray(items)||existingJobs.length!==items.length)throw new Error("Media batch replay inspection requires aligned jobs and items.");
 const exists=existingJobs.some(Boolean);
 if(!exists)return{exists:false,matches:false,batchId:null};
 if(existingJobs.some(job=>!job))return{exists:true,matches:false,batchId:null};
 let first;try{first=JSON.parse(existingJobs[0].input_json||"{}");}catch{return{exists:true,matches:false,batchId:null};}
 const batchId=typeof first.batchId==="string"&&first.batchId?first.batchId:null;
 if(!batchId)return{exists:true,matches:false,batchId:null};
 const matches=existingJobs.every((job,index)=>{
  if(job.job_type!==jobType||job.project_id!==projectId)return false;
  let input;try{input=JSON.parse(job.input_json||"{}");}catch{return false;}
  const comparable={...input};delete comparable.batchId;delete comparable.batchIndex;delete comparable.batchTotal;
  const expected={sourceAssetId:items[index].sourceAssetId,...items[index].options,batchOperation:jobType};
  return input.batchId===batchId&&input.batchIndex===index&&input.batchTotal===items.length&&JSON.stringify(comparable,Object.keys(comparable).sort())===JSON.stringify(expected,Object.keys(expected).sort());
 });
 return{exists:true,matches,batchId};
}
