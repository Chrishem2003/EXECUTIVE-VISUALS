const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const map=row=>({id:row.id,reviewId:row.review_id,authorId:row.author_id,body:row.body,createdAt:row.created_at,updatedAt:row.updated_at});
export function createCloudReviewConversationRepository({url=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl=globalThis.fetch,authorize,projects,reviews,timeoutMs=12000}={}){
 if(!url||!serviceRoleKey||typeof fetchImpl!=="function"||typeof authorize!=="function"||!projects||!reviews)throw new Error("Review conversations require credentials, authorization and review repositories.");
 const parsed=new URL(url);if(parsed.protocol!=="https:"&& !["localhost","127.0.0.1","[::1]"].includes(parsed.hostname))throw new Error("Review conversation URL must use HTTPS.");
 const base=parsed.origin;
 async function request(path,{method="GET",body=null}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{const headers={apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,"accept-profile":"executive_visuals","content-profile":"executive_visuals",accept:"application/json",prefer:"return=representation"};if(body!==null)headers["content-type"]="application/json";
   const res=await fetchImpl(base+"/rest/v1/"+path,{method,headers,...(body===null?{}:{body:JSON.stringify(body)}),signal:controller.signal});const raw=await res.text();let data=null;if(raw){try{data=JSON.parse(raw);}catch{throw new Error("Review conversation repository received invalid JSON.");}}
   if(!res.ok){const e=new Error("Review conversation database request failed (HTTP "+res.status+").");e.status=res.status;e.code="REVIEW_CONVERSATION_DATABASE_ERROR";throw e;}return data;
  }catch(e){if(e?.name==="AbortError")fail("REVIEW_CONVERSATION_TIMEOUT","Review conversation request timed out.");throw e;}finally{clearTimeout(timer);}
 }
 async function context(actorId,reviewId){
  if(typeof actorId!=="string"||!UUID.test(actorId)||typeof reviewId!=="string"||!UUID.test(reviewId))fail("REVIEW_INVALID","A valid account and review are required.");
  const parent=await reviews.get({actorId,reviewId});if(!parent)fail("REVIEW_NOT_FOUND","Review not found.");
  const project=await projects.get({ownerId:actorId,projectId:parent.projectId});if(!project)fail("REVIEW_NOT_FOUND","Review not found.");
  if(await authorize({ownerId:actorId,projectId:parent.projectId,action:"read"})!==true)fail("REVIEW_ACCESS_DENIED","Project access denied.");
  const membership=actorId===project.ownerId?{role:"owner"}:(await request("project_members?select=role&project_id=eq."+encodeURIComponent(parent.projectId)+"&member_id=eq."+encodeURIComponent(actorId)+"&limit=1"))?.[0]||null;
  if(!["owner","editor","reviewer"].includes(membership?.role))fail("REVIEW_ACCESS_DENIED","Project reviewer access is required to reply.");
  return{parent,project};
 }
 return Object.freeze({
  async list({actorId,reviewId}={}){await context(actorId,reviewId);const rows=await request("review_replies?select=id,review_id,author_id,body,created_at,updated_at&review_id=eq."+encodeURIComponent(reviewId)+"&order=created_at.asc&limit=200");return(Array.isArray(rows)?rows:[]).map(map);},
  async create({actorId,reviewId,body}={}){const {parent,project}=await context(actorId,reviewId);if(typeof body!=="string"||!body.trim()||body.trim().length>5000)fail("REVIEW_INVALID","Reply must contain 1 to 5,000 characters.");const row={id:crypto.randomUUID(),owner_id:project.ownerId,project_id:parent.projectId,review_id:reviewId,author_id:actorId,body:body.trim()};const rows=await request("review_replies?select=id,review_id,author_id,body,created_at,updated_at",{method:"POST",body:row});if(!Array.isArray(rows)||rows.length!==1||rows[0].id!==row.id)throw new Error("Review reply creation returned an invalid receipt.");return map(rows[0]);}
 });
}
