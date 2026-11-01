import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createCloudAssetAuthorizer } from "./cloud-asset-auth.mjs";
import { createCloudTimelineService } from "./cloud-timeline-service.mjs";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeId=(value)=>typeof value==="string"&&UUID.test(value);

/**
 * Authenticated cloud timeline API. The caller must pass the user ID returned
 * by the app's verified authentication middleware; request bodies never set
 * owner_id. Service-role credentials remain inside this server-only module.
 */
export function createCloudTimelineApi({url=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl=globalThis.fetch,timelineService,authorize,maxJobBytes=5*1024*1024,timeoutMs=15000,maxUploadBytes=250*1024*1024,tempRoot=tmpdir()}={}){
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
   const projectMatch=path.match(/^\/api\/cloud\/projects\/([0-9a-f-]+)$/i);
   if(projectMatch&&safeId(projectMatch[1])){
    const projectId=projectMatch[1];
    if(method==="GET"){const project=await service.projects.get({ownerId,projectId});return project?response(200,{project}):response(404,{error:{code:"PROJECT_NOT_FOUND",message:"Project not found."}});}
    if(method==="PATCH"){const project=await service.projects.update({ownerId,projectId,expectedRevision:Number(body.expectedRevision),name:body.name,description:body.description,settings:body.settings});return response(200,{project});}
    if(method==="DELETE"){const archived=await service.projects.archive({ownerId,projectId,expectedRevision:Number(body.expectedRevision)});return response(200,{project:archived});}
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
    const key=typeof idempotencyKey==="string"?idempotencyKey.slice(0,180):"";
    if(key){
     const existing=await request("jobs?select=id,owner_id,project_id,job_type,status,progress,input,output,error,created_at,updated_at&idempotency_key=eq."+encodeURIComponent(key)+"&owner_id=eq."+encodeURIComponent(ownerId)+"&limit=1");
     if(Array.isArray(existing)&&existing[0]){
      const row=existing[0],input=row.input||{};
      if(row.job_type!=="timeline.render"||input.timelineId!==timelineId||input.timelineRevision!==timeline.revision)return response(409,{error:{code:"IDEMPOTENCY_CONFLICT",message:"This idempotency key belongs to a different render request."}});
      return response(200,{job:row,idempotentReplay:true});
     }
    }
    const jobId=randomUUID(),input={timelineId,timelineRevision:timeline.revision};
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
  const extensions={"image/jpeg":"jpg","image/png":"png","image/webp":"webp","image/gif":"gif","video/mp4":"mp4","video/webm":"webm","video/quicktime":"mov","video/x-matroska":"mkv","audio/mpeg":"mp3","audio/wav":"wav","audio/x-wav":"wav","audio/mp4":"m4a","audio/ogg":"ogg","application/pdf":"pdf","text/plain":"txt","text/vtt":"vtt","application/json":"json"};
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
   const asset=await service.assets.createFromFile({ownerId,projectId,originalName:name,mediaType,filePath,metadata:{ingest:"cloud-api"}});
   return response(201,{asset});
  }catch(error){
   if(error.code==="UPLOAD_TOO_LARGE")return response(413,{error:{code:error.code,message:error.message}});
   if(error.code==="CLOUD_ASSET_ACCESS_DENIED"||error.code==="CLOUD_ASSET_NOT_FOUND")return response(404,{error:{code:"ASSET_NOT_FOUND",message:"Asset not found."}});
   throw error;
  }finally{await rm(directory,{recursive:true,force:true}).catch(()=>{});}
 }
 return Object.freeze({handle,uploadAsset,checkReadiness});
}
