import { randomUUID } from "node:crypto";
import { createCloudAssetAuthorizer } from "./cloud-asset-auth.mjs";
import { createCloudTimelineService } from "./cloud-timeline-service.mjs";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeId=(value)=>typeof value==="string"&&UUID.test(value);

/**
 * Authenticated cloud timeline API. The caller must pass the user ID returned
 * by the app's verified authentication middleware; request bodies never set
 * owner_id. Service-role credentials remain inside this server-only module.
 */
export function createCloudTimelineApi({url=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl=globalThis.fetch,timelineService,authorize,maxJobBytes=5*1024*1024,timeoutMs=15000}={}){
 if(!url||!serviceRoleKey)throw new Error("Cloud timeline API requires server-side Supabase credentials.");
 if(typeof fetchImpl!=="function")throw new Error("Cloud timeline API requires fetch.");
 if(!Number.isInteger(maxJobBytes)||maxJobBytes<1024||maxJobBytes>10*1024*1024)throw new Error("Cloud timeline API payload limit is invalid.");
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>60000)throw new Error("Cloud timeline API timeout is invalid.");
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
 async function handle({method,path,ownerId,body={},idempotencyKey=null}={}){
  if(!["GET","POST","PUT"].includes(method)||typeof path!=="string")return null;
  if(!safeId(ownerId))return response(401,{error:{code:"AUTH_REQUIRED",message:"A verified account identity is required."}});
  if(Buffer.byteLength(JSON.stringify(body||{}))>maxJobBytes)return response(413,{error:{code:"PAYLOAD_TOO_LARGE",message:"Cloud timeline request is too large."}});
  try{
   if(path==="/api/cloud/timelines"&&method==="POST"){
    const timeline=await service.timelines.create({ownerId,projectId:body.projectId||null,name:body.name||"Untitled timeline",timeline:body.timeline,otio:body.otio??null});
    return response(201,{timeline});
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
   if(["CLOUD_TIMELINE_NOT_FOUND","CLOUD_ASSET_NOT_FOUND"].includes(error.code))return response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline or one of its assets was not found."}});
   if(["CLOUD_TIMELINE_ACCESS_DENIED","CLOUD_ASSET_ACCESS_DENIED"].includes(error.code))return response(404,{error:{code:"TIMELINE_NOT_FOUND",message:"Timeline not found."}});
   if(error.code==="CLOUD_TIMELINE_REVISION_CONFLICT")return response(409,{error:{code:"REVISION_CONFLICT",message:"Timeline changed since it was loaded. Refresh and retry."}});
   if(error.code==="CLOUD_TIMELINE_INVALID")return response(422,{error:{code:"TIMELINE_INVALID",message:error.message,issues:error.issues||[]}});
   if(error.status===409)return response(409,{error:{code:"IDEMPOTENCY_CONFLICT",message:"The render request conflicts with an existing job."}});
   throw error;
  }
 }
 return Object.freeze({handle});
}
