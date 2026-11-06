import { randomUUID } from "node:crypto";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{3}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED=new Set(["👍","❤️","🎉","👀","✅","💯"]);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const map=row=>({id:row.id,reviewId:row.review_id,actorId:row.actor_id,emoji:row.emoji,createdAt:row.created_at});
export function createCloudReviewReactionRepository({url=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl=globalThis.fetch,authorize,projects,reviews,timeoutMs=12000}={}){
 if(!url||!serviceRoleKey||typeof fetchImpl!=="function"||typeof authorize!=="function"||!projects||!reviews)throw new Error("Review reactions require credentials, authorization and review repositories.");
 const parsed=new URL(url);if(parsed.protocol!=="https:"&& !["localhost","127.0.0.1","[::1]"].includes(parsed.hostname))throw new Error("Review reaction URL must use HTTPS.");
 const base=parsed.origin;
 async function request(path,{method="GET",body=null,prefer="return=representation"}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{const headers={apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,"accept-profile":"executive_visuals","content-profile":"executive_visuals",accept:"application/json",prefer};if(body!==null)headers["content-type"]="application/json";
   const res=await fetchImpl(base+"/rest/v1/"+path,{method,headers,...(body===null?{}:{body:JSON.stringify(body)}),signal:controller.signal});const raw=await res.text();let data=null;if(raw){try{data=JSON.parse(raw);}catch{throw new Error("Review reaction repository received invalid JSON.");}}
   if(!res.ok){const e=new Error("Review reaction database request failed (HTTP "+res.status+").");e.status=res.status;e.code="REVIEW_REACTION_DATABASE_ERROR";throw e;}return data;
  }catch(e){if(e?.name==="AbortError")fail("REVIEW_REACTION_TIMEOUT","Review reaction request timed out.");throw e;}finally{clearTimeout(timer);}
 }
 async function context(actorId,reviewId){
  if(typeof actorId!=="string"||!UUID.test(actorId)||typeof reviewId!=="string"||!UUID.test(reviewId))fail("REVIEW_INVALID","A valid account and review are required.");
  const parent=await reviews.get({actorId,reviewId});if(!parent)fail("REVIEW_NOT_FOUND","Review not found.");
  const project=await projects.get({ownerId:actorId,projectId:parent.projectId});if(!project)fail("REVIEW_NOT_FOUND","Review not found.");
  if(await authorize({ownerId:actorId,projectId:parent.projectId,action:"read"})!==true)fail("REVIEW_ACCESS_DENIED","Project access denied.");
  const membership=actorId===project.ownerId?{role:"owner"}:(await request("project_members?select=role&project_id=eq."+encodeURIComponent(parent.projectId)+"&member_id=eq."+encodeURIComponent(actorId)+"&limit=1"))?.[0]||null;
  if(!["owner","editor","reviewer","viewer"].includes(membership?.role))fail("REVIEW_ACCESS_DENIED","Project membership is required to access reactions.");
  return{parent,project,membership};
 }
 return Object.freeze({
  async list({actorId,reviewId}={}){await context(actorId,reviewId);const rows=await request("review_reactions?select=id,review_id,actor_id,emoji,created_at&review_id=eq."+encodeURIComponent(reviewId)+"&order=created_at.asc&limit=500");return(Array.isArray(rows)?rows:[]).map(map);},
  async add({actorId,reviewId,emoji}={}){const {parent,project,membership}=await context(actorId,reviewId);if(!["owner","editor","reviewer"].includes(membership?.role))fail("REVIEW_ACCESS_DENIED","Reviewer access is required to react.");if(!ALLOWED.has(emoji))fail("REVIEW_INVALID","Choose a supported reaction.");const row={id:randomUUID(),owner_id:project.ownerId,project_id:parent.projectId,review_id:reviewId,actor_id:actorId,emoji};const rows=await request("review_reactions?on_conflict=review_id,actor_id,emoji&select=id,review_id,actor_id,emoji,created_at",{method:"POST",body:row,prefer:"resolution=merge-duplicates,return=representation"});if(!Array.isArray(rows)||rows.length!==1||rows[0].review_id!==reviewId||rows[0].actor_id!==actorId||rows[0].emoji!==emoji)throw new Error("Review reaction creation returned an invalid receipt.");return map(rows[0]);},
  async remove({actorId,reviewId,emoji}={}){await context(actorId,reviewId);if(!ALLOWED.has(emoji))fail("REVIEW_INVALID","Choose a supported reaction.");const rows=await request("review_reactions?review_id=eq."+encodeURIComponent(reviewId)+"&actor_id=eq."+encodeURIComponent(actorId)+"&emoji=eq."+encodeURIComponent(emoji)+"&select=id,review_id,actor_id,emoji,created_at",{method:"DELETE"});return(Array.isArray(rows)?rows:[]).map(map);}
 });
}
