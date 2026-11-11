const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const map=row=>({id:String(row.id),reviewId:row.review_id,actorId:row.actor_id,eventType:row.event_type,eventData:row.event_data||{},createdAt:row.created_at});
export function createCloudReviewEventRepository({url=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl=globalThis.fetch,authorize,projects,reviews,timeoutMs=12000}={}){
 if(!url||!serviceRoleKey||typeof fetchImpl!=="function"||typeof authorize!=="function"||!projects||!reviews)throw new Error("Review events require credentials, authorization and review repositories.");
 const parsed=new URL(url);if(parsed.protocol!=="https:"&& !["localhost","127.0.0.1","[::1]"].includes(parsed.hostname))throw new Error("Review event URL must use HTTPS.");
 const base=parsed.origin;
 async function request(path){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const res=await fetchImpl(base+"/rest/v1/"+path,{method:"GET",headers:{apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,"accept-profile":"executive_visuals",accept:"application/json"},signal:controller.signal});
   const raw=await res.text();let data=null;if(raw){try{data=JSON.parse(raw);}catch{throw new Error("Review event repository received invalid JSON.");}}
   if(!res.ok){const e=new Error("Review event database request failed (HTTP "+res.status+").");e.status=res.status;e.code="REVIEW_EVENT_DATABASE_ERROR";throw e;}return data;
  }catch(e){if(e?.name==="AbortError")fail("REVIEW_EVENT_TIMEOUT","Review event request timed out.");throw e;}finally{clearTimeout(timer);}
 }
 return Object.freeze({
  async list({actorId,reviewId,limit=100}={}){
   if(typeof actorId!=="string"||!UUID.test(actorId)||typeof reviewId!=="string"||!UUID.test(reviewId))fail("REVIEW_INVALID","A valid account and review are required.");
   const parent=await reviews.get({actorId,reviewId});if(!parent)fail("REVIEW_NOT_FOUND","Review not found.");
   const project=await projects.get({ownerId:actorId,projectId:parent.projectId});if(!project)fail("REVIEW_NOT_FOUND","Review not found.");
   if(await authorize({ownerId:actorId,projectId:parent.projectId,action:"read"})!==true)fail("REVIEW_ACCESS_DENIED","Project access denied.");
   limit=Math.max(1,Math.min(200,Number.isInteger(limit)?limit:100));
   const rows=await request("review_events?select=id,review_id,actor_id,event_type,event_data,created_at&review_id=eq."+encodeURIComponent(reviewId)+"&order=created_at.asc,id.asc&limit="+limit);
   return(Array.isArray(rows)?rows:[]).map(map);
  }
 });
}
