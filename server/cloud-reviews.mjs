import { randomUUID } from "node:crypto";
import { normalizeReviewCreate,normalizeReviewPatch } from "./review-contract.mjs";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id=(v)=>typeof v==="string"&&UUID.test(v);
const stable=value=>Array.isArray(value)?"["+value.map(stable).join(",")+"]":value&&typeof value==="object"?"{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+stable(value[key])).join(",")+"}":JSON.stringify(value);
const map=row=>({id:row.id,projectId:row.project_id,assetId:row.asset_id||null,timelineId:row.timeline_id||null,timelineRevision:row.timeline_revision??null,frameNumber:row.frame_number===null?null:Number(row.frame_number),durationFrames:row.duration_frames??null,timecodeSeconds:row.timecode_seconds===null?null:Number(row.timecode_seconds),body:row.body,decision:row.decision,status:row.status,visibility:row.visibility||"project",annotation:row.annotation||null,authorId:row.reviewer_id||row.owner_id,createdAt:row.created_at,updatedAt:row.updated_at||row.created_at,editedAt:row.edited_at||null,resolvedAt:row.resolved_at||null,resolvedBy:row.resolved_by||null});
export function createCloudReviewRepository({url=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl=globalThis.fetch,authorize,projects,assets,timelines,timeoutMs=12000}={}){
 if(!url||!serviceRoleKey||typeof fetchImpl!=="function"||typeof authorize!=="function"||!projects||!assets||!timelines)throw new Error("Cloud review repository requires credentials, authorization and cloud repositories.");
 const parsed=new URL(url);if(parsed.protocol!=="https:"&&!["localhost","127.0.0.1","[::1]"].includes(parsed.hostname))throw new Error("Cloud review URL must use HTTPS.");
 const base=parsed.origin;
 async function request(path,{method="GET",body=null,prefer="return=representation"}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const headers={apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,"accept-profile":"executive_visuals","content-profile":"executive_visuals",accept:"application/json",prefer};
   if(body!==null)headers["content-type"]="application/json";
   const res=await fetchImpl(base+"/rest/v1/"+path,{method,headers,...(body===null?{}:{body:JSON.stringify(body)}),signal:controller.signal});
   const raw=await res.text();let data=null;if(raw){try{data=JSON.parse(raw);}catch{throw new Error("Cloud review repository received invalid JSON.");}}
   if(!res.ok){const e=new Error("Cloud review database request failed (HTTP "+res.status+").");e.status=res.status;e.code="CLOUD_REVIEW_DATABASE_ERROR";throw e;}
   return data;
  }catch(e){if(e?.name==="AbortError"){const x=new Error("Cloud review request timed out.");x.code="CLOUD_REVIEW_TIMEOUT";throw x;}throw e;}finally{clearTimeout(timer);}
 }
 async function context(actorId,projectId,action="read"){
  if(!id(actorId)||!id(projectId))throw Object.assign(new Error("A valid account and project are required."),{code:"CLOUD_REVIEW_INVALID"});
  const project=await projects.get({ownerId:actorId,projectId});
  if(!project)throw Object.assign(new Error("Project not found."),{code:"CLOUD_REVIEW_NOT_FOUND"});
  if(await authorize({ownerId:actorId,projectId,action})!==true)throw Object.assign(new Error("Project access denied."),{code:"CLOUD_REVIEW_ACCESS_DENIED"});
  const membership=actorId===project.ownerId?{role:"owner"}:(await request("project_members?select=role&project_id=eq."+encodeURIComponent(projectId)+"&member_id=eq."+encodeURIComponent(actorId)+"&limit=1"))?.[0]||null;
  return{project,membership};
 }
 function visible(row,actorId,project,membership){
  return row.visibility!=="internal"||actorId===project.ownerId||row.reviewer_id===actorId||["editor","reviewer"].includes(membership?.role);
 }
 async function getRow(reviewId){
  const rows=await request("reviews?select=*&id=eq."+encodeURIComponent(reviewId)+"&limit=1");
  return Array.isArray(rows)?rows[0]||null:null;
 }
 return Object.freeze({
  async create({actorId,input,idempotencyKey}={}){
   const payload={...input};if(payload.requestId===undefined&&idempotencyKey)payload.requestId=idempotencyKey;
   const normalized=normalizeReviewCreate(payload);
   const {project,membership}=await context(actorId,normalized.projectId,"read");
   if(!["owner","editor","reviewer"].includes(membership?.role))throw Object.assign(new Error("Editor or reviewer access is required to comment."),{code:"CLOUD_REVIEW_ACCESS_DENIED"});
   if(normalized.assetId){const asset=await assets.get({ownerId:project.ownerId,assetId:normalized.assetId});if(!asset||asset.projectId!==normalized.projectId)throw Object.assign(new Error("Asset does not belong to this project."),{code:"CLOUD_REVIEW_INVALID"});}
   let timecode=normalized.timecodeSeconds;
   if(normalized.frameNumber!==null){
    if(normalized.timelineId){const timeline=await timelines.get({ownerId:project.ownerId,timelineId:normalized.timelineId});if(!timeline||timeline.projectId!==normalized.projectId||normalized.timelineRevision>timeline.revision)throw Object.assign(new Error("Timeline revision is not available in this project."),{code:"CLOUD_REVIEW_INVALID"});const rate=timeline.timeline.frameRate;timecode=normalized.frameNumber*Number(rate.denominator)/Number(rate.numerator);}

   }
   const row={id:randomUUID(),owner_id:project.ownerId,project_id:normalized.projectId,asset_id:normalized.assetId,reviewer_id:actorId,last_actor_id:actorId,timecode_seconds:timecode,body:normalized.body,decision:normalized.decision,status:"open",timeline_id:normalized.timelineId,timeline_revision:normalized.timelineRevision,frame_number:normalized.frameNumber,duration_frames:normalized.durationFrames,annotation:normalized.annotation,visibility:normalized.visibility,request_id:normalized.requestId};
   if(normalized.requestId){
    const prior=await request("reviews?select=*&reviewer_id=eq."+encodeURIComponent(actorId)+"&request_id=eq."+encodeURIComponent(normalized.requestId)+"&limit=1");
    if(Array.isArray(prior)&&prior[0]){const p=prior[0];if(p.project_id!==row.project_id||p.reviewer_id!==actorId||p.body!==row.body||p.asset_id!==row.asset_id||p.timeline_id!==row.timeline_id||p.timeline_revision!==row.timeline_revision||p.frame_number!==row.frame_number||p.duration_frames!==row.duration_frames||p.decision!==row.decision||p.visibility!==row.visibility||stable(p.annotation||null)!==stable(row.annotation||null)||Number(p.timecode_seconds??0)!==Number(row.timecode_seconds??0))throw Object.assign(new Error("Request ID was already used for a different review."),{code:"CLOUD_REVIEW_IDEMPOTENCY_CONFLICT"});return{review:map(p),idempotentReplay:true};}
   }
   const rows=await request("reviews?select=*",{method:"POST",body:row});
   if(!Array.isArray(rows)||rows.length!==1||rows[0].id!==row.id)throw new Error("Cloud review creation returned an invalid receipt.");
   return{review:map(rows[0]),idempotentReplay:false};
  },
  async list({actorId,projectId,assetId=null,limit=100,offset=0}={}){
   const {project,membership}=await context(actorId,projectId,"read");
   limit=Math.max(1,Math.min(200,Number.isInteger(limit)?limit:100));offset=Math.max(0,Math.min(100000,Number.isInteger(offset)?offset:0));
   let path="reviews?select=*&project_id=eq."+encodeURIComponent(projectId)+"&order=created_at.asc&limit="+limit+"&offset="+offset;
   if(assetId){if(!id(assetId))throw Object.assign(new Error("Asset ID is invalid."),{code:"CLOUD_REVIEW_INVALID"});path+="&asset_id=eq."+encodeURIComponent(assetId);}
   const rows=await request(path);
   return(Array.isArray(rows)?rows:[]).filter(row=>visible(row,actorId,project,membership)).map(map);
  },
  async get({actorId,reviewId}={}){
   if(!id(reviewId))return null;
   const row=await getRow(reviewId);if(!row)return null;
   const {project,membership}=await context(actorId,row.project_id,"read");
   if(!await visible(row,actorId,project,membership))return null;
   return map(row);
  },
  async update({actorId,reviewId,input}={}){
   const patch=normalizeReviewPatch(input),row=await getRow(reviewId);if(!row)throw Object.assign(new Error("Review not found."),{code:"CLOUD_REVIEW_NOT_FOUND"});
   const {project,membership}=await context(actorId,row.project_id,"read");
   const ownerOrEditor=actorId===project.ownerId||membership?.role==="editor";
   if(!ownerOrEditor&&row.reviewer_id!==actorId)throw Object.assign(new Error("Only the comment author or a project editor can change this review."),{code:"CLOUD_REVIEW_ACCESS_DENIED"});
   if(patch.visibility==="internal"&&membership?.role==="viewer")throw Object.assign(new Error("Viewer accounts cannot create internal comments."),{code:"CLOUD_REVIEW_ACCESS_DENIED"});
   const update={...patch,updated_at:new Date().toISOString(),last_actor_id:actorId};
   if(patch.status==="resolved"){update.resolved_at=new Date().toISOString();update.resolved_by=actorId;}
   if(patch.status==="open"){update.resolved_at=null;update.resolved_by=null;}
   const rows=await request("reviews?id=eq."+encodeURIComponent(reviewId)+"&updated_at=eq."+encodeURIComponent(row.updated_at||row.created_at),{method:"PATCH",body:update});
   if(!Array.isArray(rows)||rows.length!==1)throw Object.assign(new Error("Review changed while it was being edited. Refresh and retry."),{code:"CLOUD_REVIEW_CONFLICT"});
   return map(rows[0]);
  }
 });
}
