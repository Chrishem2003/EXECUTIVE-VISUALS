import { randomUUID, createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, readFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, extname, relative } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createCloudAssetAuthorizer } from "./cloud-asset-auth.mjs";
import { createCloudTimelineService } from "./cloud-timeline-service.mjs";
import { buildTransformationReadinessReport } from "./transformation-readiness.mjs";
import { validateSrt, validateWebVtt } from "./caption-validation.mjs";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeId=(value)=>typeof value==="string"&&UUID.test(value);
const stableJson=value=>Array.isArray(value)?"["+value.map(stableJson).join(",")+"]":value&&typeof value==="object"?"{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+stableJson(value[key])).join(",")+"}":JSON.stringify(value);

function validateMasteringOptions(value){
 if(value===undefined||value===null)return null;
 if(!value||typeof value!=="object"||Array.isArray(value))throw Object.assign(new Error("Mastering settings must be an object."),{code:"INVALID_MASTERING_OPTIONS"});
 const allowed=new Set(["enabled","integratedLufs","loudnessRange","truePeakDbtp","dualMono","tolerance"]);
 if(Object.keys(value).some(key=>!allowed.has(key)))throw Object.assign(new Error("Mastering settings contain an unsupported option."),{code:"INVALID_MASTERING_OPTIONS"});
 if(value.enabled!==true)throw Object.assign(new Error("Mastering settings must explicitly enable mastering."),{code:"INVALID_MASTERING_OPTIONS"});
 const ranges={integratedLufs:[-70,-5],loudnessRange:[1,50],truePeakDbtp:[-9,0],tolerance:[0,3]};
 const result={enabled:true};
 for(const [key,[minimum,maximum]] of Object.entries(ranges)){
  if(value[key]===undefined)continue;
  if(typeof value[key]!=="number"||!Number.isFinite(value[key])||value[key]<minimum||value[key]>maximum)throw Object.assign(new Error("Mastering option "+key+" is outside its supported range."),{code:"INVALID_MASTERING_OPTIONS"});
  result[key]=value[key];
 }
 if(value.dualMono!==undefined){if(typeof value.dualMono!=="boolean")throw Object.assign(new Error("Mastering option dualMono must be a boolean."),{code:"INVALID_MASTERING_OPTIONS"});result.dualMono=value.dualMono;}
 return result;
}

/**
 * Authenticated cloud timeline API. The caller must pass the user ID returned
 * by the app's verified authentication middleware; request bodies never set
 * owner_id. Service-role credentials remain inside this server-only module.
 */
export function createCloudTimelineApi({url=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl=globalThis.fetch,timelineService,authorize,maxJobBytes=5*1024*1024,timeoutMs=15000,maxUploadBytes=250*1024*1024,tempRoot=tmpdir(),transformationReadiness=()=>({}),waveformCache=null,mediaRoot=null}={}){
 if(!url||!serviceRoleKey)throw new Error("Cloud timeline API requires server-side Supabase credentials.");
 if(typeof fetchImpl!=="function")throw new Error("Cloud timeline API requires fetch.");
 if(!Number.isInteger(maxJobBytes)||maxJobBytes<1024||maxJobBytes>10*1024*1024)throw new Error("Cloud timeline API payload limit is invalid.");
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>60000)throw new Error("Cloud timeline API timeout is invalid.");
 if(!Number.isInteger(maxUploadBytes)||maxUploadBytes<1||maxUploadBytes>1024*1024*1024)throw new Error("Cloud asset upload limit is invalid.");
 const service=timelineService||createCloudTimelineService({url,serviceRoleKey,fetchImpl});
 const allow=authorize||createCloudAssetAuthorizer({url,serviceRoleKey,fetchImpl});
 const base=new URL(url).origin;
 async function request(path,{method="GET",body=null,prefer="return=representation"}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
  const headers={apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,"accept-profile":"executive_visuals","content-profile":"executive_visuals",accept:"application/json",prefer};
  if(body!==null)headers["content-type"]="application/json";
  const response=await fetchImpl(base+"/rest/v1/"+path,{method,headers,...(body===null?{}:{body:JSON.stringify(body)}),signal:controller.signal});
  const raw=await response.text();let data=null;if(raw){try{data=JSON.parse(raw);}catch{throw new Error("Cloud timeline API received an invalid database response.");}}
  if(!response.ok){const error=new Error("Cloud timeline API database request failed (HTTP "+response.status+").");error.status=response.status;error.code="CLOUD_TIMELINE_API_DATABASE_ERROR";throw error;}
  return data;
  }catch(error){if(error?.name==="AbortError"){const timeout=new Error("Cloud timeline API request timed out.");timeout.code="CLOUD_TIMELINE_API_TIMEOUT";throw timeout;}throw error;}finally{clearTimeout(timer);}
 }
 const response=(status,body)=>({status,body});
 async function handle({method,path,ownerId,body={},query={},idempotencyKey=null}={}){
  if(!["GET","POST","PUT","PATCH","DELETE"].includes(method)||typeof path!=="string")return null;
  if(!safeId(ownerId))return response(401,{error:{code:"AUTH_REQUIRED",message:"A verified account identity is required."}});
  if(Buffer.byteLength(JSON.stringify(body||{}))>maxJobBytes)return response(413,{error:{code:"PAYLOAD_TOO_LARGE",message:"Cloud timeline request is too large."}});
  try{
   if(path==="/api/cloud/projects"&&method==="POST"){
    const project=await service.projects.create({ownerId,name:body.name,description:body.description||"",settings:body.settings||{}});
    return response(201,{project});
   }
   if(path==="/api/cloud/projects"&&method==="GET"){
    const projects=await service.projects.list({ownerId,limit:Number(query.limit)||50,offset:Number(query.offset)||0});
    return response(200,{projects});
   }
   if(path==="/api/cloud/jobs"&&method==="GET"){
    const projectId=String(query.projectId||"");
    if(!safeId(projectId))return response(400,{error:{code:"PROJECT_REQUIRED",message:"A valid project ID is required to inspect cloud render history."}});
    if(await allow({ownerId,projectId,action:"read"})!==true)return response(404,{error:{code:"PROJECT_NOT_FOUND",message:"Project not found."}});
    const requestedLimit=Number(query.limit)||20,limit=Math.max(1,Math.min(50,Math.floor(requestedLimit)));
    const rows=await request("jobs?select=id,owner_id,project_id,job_type,status,progress,input,output,error,attempt_count,created_at,updated_at,completed_at&project_id=eq."+encodeURIComponent(projectId)+"&job_type=eq.timeline.render&order=created_at.desc&limit="+limit);
    return response(200,{jobs:Array.isArray(rows)?rows:[]});
   }
   const projectMatch=path.match(/^\/api\/cloud\/projects\/([0-9a-f-]+)$/i);
   if(projectMatch&&safeId(projectMatch[1])){
    const projectId=projectMatch[1];
    if(method==="GET"){const project=await service.projects.get({ownerId,projectId});return project?response(200,{project}):response(404,{error:{code:"PROJECT_NOT_FOUND",message:"Project not found."}});}
    if(method==="PATCH"){const project=await service.projects.update({ownerId,projectId,expectedRevision:Number(body.expectedRevision),name:body.name,description:body.description,settings:body.settings});return response(200,{project});}
    if(method==="DELETE"){const archived=await service.projects.archive({ownerId,projectId,expectedRevision:Number(body.expectedRevision)});return response(200,{project:archived});}
   }
   const waveformMatch=path.match(/^\/api\/cloud\/assets\/([0-9a-f-]+)\/waveform$/i);
   if(waveformMatch&&method==="GET"){
    if(!waveformCache||!mediaRoot||typeof service.storage?.downloadToFile!=="function"||typeof service.storage?.uploadFile!=="function")return response(503,{error:{code:"CLOUD_WAVEFORM_UNAVAILABLE",message:"Cloud waveform processing is not configured."}});
    const asset=await service.assets.get({ownerId,assetId:waveformMatch[1]});
    if(!asset.mediaType?.startsWith("audio/"))return response(415,{error:{code:"WAVEFORM_UNSUPPORTED_MEDIA",message:"Waveforms are available only for audio assets."}});
    if(!/^[a-f0-9]{64}$/i.test(String(asset.sha256||""))||!Number.isSafeInteger(asset.size)||asset.size<1||asset.storageBucket!=="executive-visuals-media"||typeof asset.objectPath!=="string")return response(422,{error:{code:"CLOUD_WAVEFORM_ASSET_INVALID",message:"Cloud audio asset metadata is invalid."}});
    const expectedPrefix=(asset.projectId||asset.ownerId)+"/"+asset.id+"/";
    if(!asset.objectPath.startsWith(expectedPrefix))return response(422,{error:{code:"CLOUD_WAVEFORM_PATH_INVALID",message:"Cloud audio storage reference is invalid."}});
    const objectDirectory=asset.objectPath.slice(0,asset.objectPath.lastIndexOf("/")+1);
    const derivativePath=objectDirectory+"waveform-v1-"+asset.sha256+".png";
    const workRoot=join(mediaRoot,"derived","cloud-waveform-work");
    await mkdir(workRoot,{recursive:true});
    const workDirectory=await mkdtemp(join(workRoot,"asset-"));
    const cachedPath=join(workDirectory,"cached.png");
    const sourcePath=join(workDirectory,"source"+(extname(asset.name||"audio.wav")||".audio"));
    try{
     let derivativeFile=cachedPath;
     try{
      await service.storage.downloadToFile(derivativePath,cachedPath,2*1024*1024);
      const cachedBytes=await readFile(cachedPath);
      if(cachedBytes.length<=8||!cachedBytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error("Cached cloud waveform is invalid.");
     }catch(error){
      const missing=error.code==="CLOUD_STORAGE_HTTP_404",corrupt=error.message==="Cached cloud waveform is invalid.";
      if(!missing&&!corrupt)throw error;
      if(corrupt)await service.storage.remove(derivativePath);
      const downloaded=await service.storage.downloadToFile(asset.objectPath,sourcePath,Math.min(250*1024*1024,asset.size));
      if(downloaded.sha256!==asset.sha256||downloaded.size!==asset.size)throw Object.assign(new Error("Cloud audio source checksum does not match its asset record."),{code:"CLOUD_WAVEFORM_SOURCE_INTEGRITY"});
      const localAsset={id:asset.id,sha256:asset.sha256,media_type:asset.mediaType,byte_size:asset.size,storage_path:relative(mediaRoot,sourcePath)};
      derivativeFile=await waveformCache.get(localAsset,sourcePath);
      const uploaded=await service.storage.uploadFile(derivativePath,derivativeFile,"image/png",true);
      const derivativeInfo=await stat(derivativeFile);
      if(uploaded?.bucket!=="executive-visuals-media"||uploaded?.path!==derivativePath||uploaded?.size!==derivativeInfo.size||uploaded?.contentType!=="image/png")throw new Error("Cloud waveform derivative upload receipt is invalid.");
     }
     const info=await stat(derivativeFile);
     if(!info.isFile()||info.size<=8||info.size>2*1024*1024)throw new Error("Cloud waveform derivative failed validation.");
     return{status:200,body:{assetId:asset.id,sourceSha256:asset.sha256,algorithm:"waveform-v1"},waveformPath:derivativeFile,cleanupDirectory:workDirectory};
    }catch(error){
     await rm(workDirectory,{recursive:true,force:true}).catch(()=>{});
     throw error;
    }
   }
   if(path==="/api/cloud/assets"&&method==="GET"){
    const assets=await service.assets.list({ownerId,projectId:query.projectId||null,limit:Number(query.limit)||50,offset:Number(query.offset)||0});
    return response(200,{assets});
   }
   if(path==="/api/cloud/timelines"&&method==="GET"){
    const timelines=await service.timelines.list({ownerId,projectId:query.projectId||null,limit:Number(query.limit)||50,offset:Number(query.offset)||0});
    return response(200,{timelines});
   }
   if(path==="/api/cloud/timelines"&&method==="POST"){
    const timeline=await service.timelines.create({ownerId,projectId:body.projectId||null,name:body.name||"Untitled timeline",timeline:body.timeline,otio:body.otio??null});
    return response(201,{timeline});
   }
   const assetMatch=path.match(/^\/api\/cloud\/assets\/([0-9a-f-]+)$/i);
   if(assetMatch&&safeId(assetMatch[1])){
    if(method==="GET"){
     const signed=await service.assets.createSignedUrl({ownerId,assetId:assetMatch[1],expiresIn:300});
     return response(200,{asset:signed.asset,url:signed.url,expiresIn:300});
    }
    if(method==="DELETE"){
     const result=await service.assets.softDelete({ownerId,assetId:assetMatch[1]});
     return response(200,{asset:result});
    }
   }
   if(path==="/api/cloud/transformations/readiness"&&method==="GET"){
    const projectId=String(query.projectId||"");
    if(!safeId(projectId))return response(400,{error:{code:"INVALID_PROJECT_ID",message:"Choose a valid project."}});
    if(await allow({ownerId,projectId,action:"read"})!==true)return response(404,{error:{code:"PROJECT_NOT_FOUND",message:"Project not found."}});
    const evidence=await transformationReadiness({ownerId,projectId});
    return response(200,{readiness:buildTransformationReadinessReport(evidence)});
   }
   const transformationOps=new Set(["vehicle_replace","wardrobe_replace","object_replace","background_replace","person_replace","style_transfer","object_remove","relight"]);
   const preservationOptions=new Set(["camera_motion","timing","composition","source_audio","subject_identity","pose","lighting","background"]);
   const mapTransformation=row=>{
    const input=row.input||{},approval=row.estimated_cost||{};
    return {id:row.id,projectId:row.project_id,sourceAssetId:input.sourceAssetId,operation:input.operation,prompt:input.prompt,durationSeconds:input.durationSeconds,referenceAssetIds:input.referenceAssetIds||[],preservation:input.preservation||[],status:row.approved_at?"approved":row.status==="draft"?"draft":row.status,rightsConfirmed:input.rightsConfirmed===true,subjectConsentConfirmed:input.subjectConsentConfirmed===true,approval:row.approved_at?{id:approval.approvalId,estimatedCostMicros:approval.estimatedCostMicros,approvedBudgetMicros:approval.approvedBudgetMicros,currency:approval.currency,adapterId:approval.adapterId,capability:approval.capability,approvedAt:row.approved_at}:null,createdAt:row.created_at,updatedAt:row.updated_at};
   };
   if(path==="/api/cloud/transformations"&&method==="GET"){
    const projectId=String(query.projectId||"");
    if(!safeId(projectId))return response(400,{error:{code:"INVALID_PROJECT_ID",message:"Choose a valid project."}});
    if(await allow({ownerId,projectId,action:"read"})!==true)return response(404,{error:{code:"PROJECT_NOT_FOUND",message:"Project not found."}});
    const rows=await request("jobs?select=id,owner_id,project_id,job_type,status,input,estimated_cost,approved_by,approved_at,created_at,updated_at&project_id=eq."+encodeURIComponent(projectId)+"&job_type=eq.video.transform.plan&order=created_at.desc&limit=100");
    return response(200,{plans:(Array.isArray(rows)?rows:[]).filter(row=>row.owner_id===ownerId||row.project_id===projectId).map(mapTransformation)});
   }
   if(path==="/api/cloud/transformations"&&method==="POST"){
    if(!body||typeof body!=="object"||Array.isArray(body))return response(400,{error:{code:"TRANSFORMATION_BODY_INVALID",message:"Transformation request must be a JSON object."}});
    const projectId=String(body.projectId||""),sourceAssetId=String(body.sourceAssetId||""),operation=String(body.operation||"");
    if(!safeId(projectId)||await allow({ownerId,projectId,action:"write"})!==true)return response(404,{error:{code:"PROJECT_NOT_FOUND",message:"Project not found or editor access required."}});
    if(!transformationOps.has(operation))return response(400,{error:{code:"TRANSFORMATION_OPERATION_INVALID",message:"Choose a supported transformation."}});
    const prompt=typeof body.prompt==="string"?body.prompt.trim().slice(0,12000):"";
    const duration=Number(body.durationSeconds);
    if(prompt.length<8||!Number.isInteger(duration)||duration<1||duration>30)return response(400,{error:{code:"TRANSFORMATION_INPUT_INVALID",message:"Provide an edit prompt and a duration from 1 to 30 seconds."}});
    if(body.rightsConfirmed!==true)return response(403,{error:{code:"MEDIA_RIGHTS_REQUIRED",message:"Confirm rights to use the source and reference media."}});
    if(operation==="person_replace"&&body.subjectConsentConfirmed!==true)return response(403,{error:{code:"SUBJECT_CONSENT_REQUIRED",message:"Explicit subject consent is required for person replacement."}});
    const source=await service.assets.get({ownerId,assetId:sourceAssetId});
    if(source.projectId!==projectId||!source.mediaType.startsWith("video/"))return response(422,{error:{code:"SOURCE_VIDEO_INVALID",message:"Source video must be an asset in this project."}});
    const refs=Array.isArray(body.referenceAssetIds)?[...new Set(body.referenceAssetIds.map(String))]:[];
    if(refs.length>4)return response(400,{error:{code:"REFERENCE_LIMIT_EXCEEDED",message:"Use no more than four reference images."}});
    for(const id of refs){const asset=await service.assets.get({ownerId,assetId:id});if(asset.projectId!==projectId||!asset.mediaType.startsWith("image/"))return response(422,{error:{code:"REFERENCE_ASSET_INVALID",message:"Every reference must be a project image asset."}});}
    const preservation=Array.isArray(body.preservation)?[...new Set(body.preservation.filter(value=>preservationOptions.has(value)))]:[];
    const key=String(idempotencyKey||"").trim().slice(0,180);
    if(key.length<8)return response(400,{error:{code:"IDEMPOTENCY_KEY_REQUIRED",message:"An idempotency key is required."}});
    const input={projectId,sourceAssetId,operation,prompt,durationSeconds:duration,referenceAssetIds:refs,preservation,rightsConfirmed:true,subjectConsentConfirmed:body.subjectConsentConfirmed===true};
    const existing=await request("jobs?select=id,owner_id,project_id,job_type,status,input,estimated_cost,approved_by,approved_at,created_at,updated_at&owner_id=eq."+encodeURIComponent(ownerId)+"&idempotency_key=eq."+encodeURIComponent(key)+"&limit=1");
    if(Array.isArray(existing)&&existing[0]){
     const row=existing[0];
     if(row.job_type!=="video.transform.plan"||stableJson(row.input)!==stableJson(input))return response(409,{error:{code:"IDEMPOTENCY_CONFLICT",message:"This idempotency key was used for a different transformation."}});
     return response(200,{plan:mapTransformation(row),idempotentReplay:true});
    }
    const id=randomUUID(),rows=await request("jobs?select=id,owner_id,project_id,job_type,status,input,estimated_cost,approved_by,approved_at,created_at,updated_at",{method:"POST",body:{id,owner_id:ownerId,project_id:projectId,job_type:"video.transform.plan",status:"draft",progress:0,input,idempotency_key:key}});
    if(!Array.isArray(rows)||rows.length!==1||rows[0].id!==id||rows[0].owner_id!==ownerId||rows[0].project_id!==projectId||rows[0].status!=="draft")throw new Error("Cloud transformation draft creation returned an invalid receipt.");
    await request("job_events",{method:"POST",body:{job_id:id,owner_id:ownerId,event_type:"transformation.draft_created",event_data:{operation,sourceAssetId}}});
    return response(201,{plan:mapTransformation(rows[0]),idempotentReplay:false});
   }
   const cloudTransformationMatch=path.match(/^\/api\/cloud\/transformations\/([0-9a-f-]+)(?:\/(approve|submit))?$/i);
   if(cloudTransformationMatch&&safeId(cloudTransformationMatch[1])){
    const rows=await request("jobs?select=id,owner_id,project_id,job_type,status,input,estimated_cost,approved_by,approved_at,created_at,updated_at&id=eq."+encodeURIComponent(cloudTransformationMatch[1])+"&job_type=eq.video.transform.plan&limit=1");
    const row=Array.isArray(rows)?rows[0]:null;
    if(!row||await allow({ownerId,projectId:row.project_id,action:"read"})!==true)return response(404,{error:{code:"TRANSFORMATION_NOT_FOUND",message:"Transformation plan not found."}});
    if(!cloudTransformationMatch[2]&&method==="GET")return response(200,{plan:mapTransformation(row)});
    if(cloudTransformationMatch[2]==="approve"&&method==="POST"){
     if(await allow({ownerId,projectId:row.project_id,action:"write"})!==true)return response(403,{error:{code:"EDITOR_REQUIRED",message:"Owner or editor access is required."}});
     if(row.status!=="draft"||row.approved_at)return response(409,{error:{code:"TRANSFORMATION_STATE_CONFLICT",message:"Only an unapproved draft can be approved."}});
     const estimate=body?.estimatedCostMicros,budget=body?.approvedBudgetMicros,currency=String(body?.currency||"").toUpperCase(),adapterId=String(body?.adapterId||"").trim(),capability=String(body?.capability||"").trim();
     if(!Number.isSafeInteger(estimate)||estimate<0||!Number.isSafeInteger(budget)||budget<estimate||! /^[A-Z]{3}$/.test(currency)||!adapterId||!capability)return response(400,{error:{code:"TRANSFORMATION_BUDGET_INVALID",message:"Provide a known estimate, a covering budget, currency, adapter and capability."}});
     const approval={approvalId:randomUUID(),estimatedCostMicros:estimate,approvedBudgetMicros:budget,currency,adapterId,capability};
     const updated=await request("jobs?id=eq."+encodeURIComponent(row.id)+"&status=eq.draft&approved_at=is.null",{method:"PATCH",body:{status:"awaiting_approval",estimated_cost:approval,approved_by:ownerId,approved_at:new Date().toISOString(),updated_at:new Date().toISOString()}});
     if(!Array.isArray(updated)||updated.length!==1)return response(409,{error:{code:"TRANSFORMATION_STATE_CONFLICT",message:"Transformation plan changed while approval was recorded."}});
     await request("job_events",{method:"POST",body:{job_id:row.id,owner_id:row.owner_id,event_type:"transformation.approved",event_data:{approvalId:approval.approvalId,estimatedCostMicros:estimate,currency}}});
     return response(200,{plan:mapTransformation(updated[0])});
    }
    if(cloudTransformationMatch[2]==="submit"&&method==="POST"){
     if(await allow({ownerId,projectId:row.project_id,action:"write"})!==true)return response(403,{error:{code:"EDITOR_REQUIRED",message:"Owner or editor access is required."}});
     if(!row.approved_at||!row.approved_by)return response(409,{error:{code:"TRANSFORMATION_APPROVAL_REQUIRED",message:"Approve the plan and budget before submission."}});
     return response(409,{error:{code:"TRANSFORMATION_ADAPTER_UNAVAILABLE",message:"No verified video-transformation adapter is enabled. No provider request or charge was made."}});
    }
   }
   const jobMatch=path.match(/^\/api\/cloud\/jobs\/([0-9a-f-]+)(?:\/(events))?$/i);
   if(jobMatch&&safeId(jobMatch[1])&&method==="GET"){
    const jobRows=await request("jobs?select=id,owner_id,project_id,job_type,status,progress,input,output,error,attempt_count,created_at,updated_at,completed_at&id=eq."+encodeURIComponent(jobMatch[1])+"&limit=1");
    const job=Array.isArray(jobRows)?jobRows[0]:null;
    if(!job)return response(404,{error:{code:"JOB_NOT_FOUND",message:"Job not found."}});
    if(job.project_id){if(await allow({ownerId,projectId:job.project_id,action:"read"})!==true)return response(404,{error:{code:"JOB_NOT_FOUND",message:"Job not found."}});}
    else if(job.owner_id!==ownerId)return response(404,{error:{code:"JOB_NOT_FOUND",message:"Job not found."}});
    if(jobMatch[2]){
     const events=await request("job_events?select=id,event_type,event_data,created_at&job_id=eq."+encodeURIComponent(job.id)+"&order=id.asc");
     return response(200,{events:Array.isArray(events)?events.map(event=>({id:event.id,type:event.event_type,data:event.event_data,createdAt:event.created_at})):[]});
    }
    return response(200,{job});
   }
   const match=path.match(/^\/api\/cloud\/timelines\/([0-9a-f-]+)(?:\/(render))?$/i);
   if(!match||!safeId(match[1]))return null;
   const timelineId=match[1];
   if(match[2]==="render"&&method==="POST"){
    if(await allow({ownerId,projectId:(await service.timelines.get({ownerId,timelineId}))?.projectId||null,action:"write"})!==true)
     return response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline not found or editor access required."}});
    const timeline=await service.timelines.get({ownerId,timelineId});
    if(!timeline)return response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline not found."}});
    const mastering=validateMasteringOptions(body?.mastering);
    const key=typeof idempotencyKey==="string"?idempotencyKey.slice(0,180):"";
    if(key){
     const existing=await request("jobs?select=id,owner_id,project_id,job_type,status,progress,input,output,error,created_at,updated_at&idempotency_key=eq."+encodeURIComponent(key)+"&owner_id=eq."+encodeURIComponent(ownerId)+"&limit=1");
     if(Array.isArray(existing)&&existing[0]){
      const row=existing[0],input=row.input||{};
      if(row.job_type!=="timeline.render"||input.timelineId!==timelineId||input.timelineRevision!==timeline.revision||stableJson(input.mastering??null)!==stableJson(mastering??null))return response(409,{error:{code:"IDEMPOTENCY_CONFLICT",message:"This idempotency key belongs to a different render request."}});
      return response(200,{job:row,idempotentReplay:true});
     }
    }
    const jobId=randomUUID(),input={timelineId,timelineRevision:timeline.revision,...(mastering?{mastering}:{})};
    const rows=await request("jobs?select=id,owner_id,project_id,job_type,status,progress,input,output,error,created_at,updated_at",{method:"POST",body:{id:jobId,owner_id:ownerId,project_id:timeline.projectId,job_type:"timeline.render",status:"queued",progress:0,input,idempotency_key:key||null}});
    if(!Array.isArray(rows)||rows.length!==1||rows[0].owner_id!==ownerId||rows[0].job_type!=="timeline.render")throw new Error("Cloud render job creation returned an invalid record.");
    await request("job_events",{method:"POST",body:{job_id:jobId,owner_id:ownerId,event_type:"job.queued",event_data:{jobType:"timeline.render",timelineId,timelineRevision:timeline.revision}},prefer:"return=minimal"});
    return response(202,{job:rows[0]});
   }
   if(method==="GET"&&!match[2]){
    const timeline=await service.timelines.get({ownerId,timelineId});
    return timeline?response(200,{timeline}):response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline not found."}});
   }
   if(method==="PUT"&&!match[2]){
    const timeline=await service.timelines.update({ownerId,timelineId,expectedRevision:Number(body.expectedRevision),timeline:body.timeline,otio:body.otio});
    return response(200,{timeline});
   }
   return null;
  }catch(error){
   if(error.code==="INVALID_MASTERING_OPTIONS")return response(422,{error:{code:error.code,message:error.message}});
   if(error.code==="CLOUD_PROJECT_NOT_FOUND"||error.code==="CLOUD_PROJECT_ACCESS_DENIED")return response(404,{error:{code:"PROJECT_NOT_FOUND",message:"Project not found."}});
   if(error.code==="CLOUD_PROJECT_REVISION_CONFLICT")return response(409,{error:{code:"REVISION_CONFLICT",message:"Project changed since it was loaded. Refresh and retry."}});
   if(error.code==="CLOUD_ASSET_NOT_FOUND")return response(404,{error:{code:"ASSET_NOT_FOUND",message:"Asset not found."}});
   if(error.code==="CLOUD_TIMELINE_NOT_FOUND")return response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline not found."}});
   if(error.code==="CLOUD_ASSET_ACCESS_DENIED")return response(404,{error:{code:"ASSET_NOT_FOUND",message:"Asset not found."}});
   if(error.code==="CLOUD_TIMELINE_ACCESS_DENIED")return response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline not found."}});
   if(error.code==="CLOUD_TIMELINE_REVISION_CONFLICT")return response(409,{error:{code:"REVISION_CONFLICT",message:"Timeline changed since it was loaded. Refresh and retry."}});
   if(error.code==="CLOUD_TIMELINE_INVALID")return response(422,{error:{code:"TIMELINE_INVALID",message:error.message,issues:error.issues||[]}});
   if(error.status===409)return response(409,{error:{code:"IDEMPOTENCY_CONFLICT",message:"The render request conflicts with an existing job."}});
   throw error;
  }
 }
 async function checkReadiness(){
  const required=["projects","project_members","assets","timelines","jobs","job_events"];
  for(const table of required){
   const rows=await request(table+"?select=id&limit=0");
   if(!Array.isArray(rows))throw new Error("Cloud timeline API readiness check failed for table "+table+".");
  }
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const result=await fetchImpl(base+"/storage/v1/bucket/executive-visuals-media",{headers:{apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,accept:"application/json"},signal:controller.signal});
   if(!result.ok)throw new Error("Cloud timeline API private storage bucket is unavailable (HTTP "+result.status+").");
   const bucket=await result.json();
   if(bucket.public!==false)throw new Error("Cloud timeline API refuses a media bucket that is not confirmed private.");
  }catch(error){if(error?.name==="AbortError")throw new Error("Cloud timeline API storage readiness check timed out.");throw error;}
  finally{clearTimeout(timer);}
  return{ready:true,storage:"private",schema:"executive_visuals"};
 }
 async function uploadAsset({req,ownerId,projectId=null,originalName="upload",mediaType="application/octet-stream"}={}){
  if(!safeId(ownerId))return response(401,{error:{code:"AUTH_REQUIRED",message:"A verified account identity is required."}});
  if(projectId!==null&&projectId!==undefined&&projectId!==""&&!safeId(projectId))return response(400,{error:{code:"INVALID_PROJECT_ID",message:"Project ID must be a UUID."}});
  projectId=projectId||null;mediaType=String(mediaType).split(";")[0].trim().toLowerCase();
  const extensions={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif","video/mp4":"mp4","video/webm":"webm","video/quicktime":"mov","video/x-matroska":"mkv","audio/mpeg":"mp3","audio/wav":"wav","audio/x-wav":"wav","audio/mp4":"m4a","audio/ogg":"ogg","application/pdf":"pdf","text/plain":"txt","application/x-subrip":"srt","text/vtt":"vtt","application/json":"json"};
  if(!extensions[mediaType])return response(415,{error:{code:"UNSUPPORTED_MEDIA_TYPE",message:"This media type is not accepted."}});
  if(!req||typeof req[Symbol.asyncIterator]!=="function")return response(400,{error:{code:"UPLOAD_STREAM_REQUIRED",message:"A binary upload stream is required."}});
  let name="upload";try{name=decodeURIComponent(String(originalName||"upload"));}catch{return response(400,{error:{code:"INVALID_FILE_NAME",message:"File name header is malformed."}});}
  name=basename(name.replace(/[\\/\u0000-\u001f\u007f]/g,"_")).normalize("NFKC").replace(/[^\p{L}\p{N}._() -]/gu,"_").slice(0,180)||"upload";
  const declared=Number(req.headers?.["content-length"]||0);if(declared>maxUploadBytes)return response(413,{error:{code:"UPLOAD_TOO_LARGE",message:"Upload exceeds the configured size limit."}});
  const directory=await mkdtemp(join(tempRoot,"ev-cloud-upload-")),filePath=join(directory,randomUUID()+"."+extensions[mediaType]);
  let size=0,header=Buffer.alloc(0);
  const meter=new Transform({transform(chunk,encoding,callback){size+=chunk.length;if(size>maxUploadBytes){callback(Object.assign(new Error("Upload exceeds the configured size limit."),{code:"UPLOAD_TOO_LARGE"}));return;}if(header.length<32)header=Buffer.concat([header,chunk.subarray(0,32-header.length)]);callback(null,chunk);}});
  try{
   await pipeline(req,meter,createWriteStream(filePath,{flags:"wx"}));
   if(size<1)return response(400,{error:{code:"EMPTY_UPLOAD",message:"Empty uploads are not accepted."}});
   const valid=mediaType==="image/png"?header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    :mediaType==="image/jpeg"?header[0]===255&&header[1]===216&&header[2]===255
    :mediaType==="image/webp"?header.subarray(0,4).toString()==="RIFF"&&header.subarray(8,12).toString()==="WEBP"
    :mediaType==="image/gif"?["GIF87a","GIF89a"].includes(header.subarray(0,6).toString())
    :["video/mp4","video/quicktime","audio/mp4"].includes(mediaType)?header.subarray(4,8).toString()==="ftyp"
    :["video/webm","video/x-matroska"].includes(mediaType)?header.subarray(0,4).equals(Buffer.from([26,69,223,163]))
    :["audio/wav","audio/x-wav"].includes(mediaType)?header.subarray(0,4).toString()==="RIFF"&&header.subarray(8,12).toString()==="WAVE"
    :mediaType==="audio/ogg"?header.subarray(0,4).toString()==="OggS"
    :mediaType==="audio/mpeg"?header.subarray(0,3).toString()==="ID3"||(header[0]===255&&(header[1]&224)===224)
    :mediaType==="application/pdf"?header.subarray(0,5).toString()==="%PDF-"
    :!header.includes(0);
   if(!valid)return response(415,{error:{code:"MEDIA_SIGNATURE_MISMATCH",message:"File signature does not match the declared media type."}});
   const captionFile=extname(name).toLowerCase();
   const captionValidation=captionFile===".srt"&&(mediaType==="text/plain"||mediaType==="application/x-subrip")?validateSrt(size>2*1024*1024?"x".repeat(2*1024*1024+1):await readFile(filePath,"utf8")):captionFile===".vtt"&&mediaType==="text/vtt"?validateWebVtt(size>2*1024*1024?"x".repeat(2*1024*1024+1):await readFile(filePath,"utf8")):null;
   const metadata={ingest:"cloud-api",...(captionValidation?{captionValidation}:{})};
   const asset=await service.assets.createFromFile({ownerId,projectId,originalName:name,mediaType,filePath,metadata});
   return response(201,{asset});
  }catch(error){
   if(error.code==="UPLOAD_TOO_LARGE")return response(413,{error:{code:error.code,message:error.message}});
   if(error.code==="CLOUD_ASSET_ACCESS_DENIED"||error.code==="CLOUD_ASSET_NOT_FOUND")return response(404,{error:{code:"ASSET_NOT_FOUND",message:"Asset not found."}});
   throw error;
  }finally{await rm(directory,{recursive:true,force:true}).catch(()=>{});}
 }
 return Object.freeze({handle,uploadAsset,checkReadiness});
}
