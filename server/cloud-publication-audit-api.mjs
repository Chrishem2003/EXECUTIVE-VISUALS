const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPES=new Set([
 "publication.cleanup_candidate_eligible",
 "publication.cleanup_candidate_skipped",
 "publication.orphan_removed",
 "publication.cleanup_completed"
]);
const FIELDS="id,run_id,event_type,actor_type,actor_id,job_id,owner_id,project_id,publication_key,claim_id,object_path,reason,dry_run,details,occurred_at";

function parseDate(value,label){
 if(typeof value!=="string"||value.length>40||!Number.isFinite(Date.parse(value)))throw new Error("Publication audit "+label+" must be a valid ISO timestamp.");
 const date=new Date(value);
 if(!/^\d{4}-\d{2}-\d{2}T/.test(value))throw new Error("Publication audit "+label+" must include a date and time.");
 return date.toISOString();
}
function encodeCursor(row){
 return Buffer.from(JSON.stringify({at:row.occurred_at,id:row.id}),"utf8").toString("base64url");
}
function decodeCursor(value){
 if(!value)return null;
 if(typeof value!=="string"||value.length>512||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error("Publication audit cursor is invalid.");
 let parsed;
 try{parsed=JSON.parse(Buffer.from(value,"base64url").toString("utf8"));}catch{throw new Error("Publication audit cursor is invalid.");}
 if(!parsed||typeof parsed!=="object"||typeof parsed.id!=="string"||!UUID.test(parsed.id))throw new Error("Publication audit cursor is invalid.");
 return {at:parseDate(parsed.at,"cursor timestamp"),id:parsed.id};
}
function safeLimit(value){
 if(value===undefined||value===null||value==="")return 50;
 if(!/^\d{1,3}$/.test(String(value)))throw new Error("Publication audit limit must be an integer between 1 and 100.");
 const n=Number(value);
 if(!Number.isInteger(n)||n<1||n>100)throw new Error("Publication audit limit must be an integer between 1 and 100.");
 return n;
}
function safeUuid(value,label,{optional=true}={}){
 if((value===undefined||value===null||value==="")&&optional)return null;
 if(typeof value!=="string"||!UUID.test(value))throw new Error("Publication audit "+label+" must be a UUID.");
 return value;
}
function safeUrl(value){
 let parsed;
 try{parsed=new URL(value);}catch{throw new Error("Publication audit URL must be an absolute URL.");}
 const local=["localhost","127.0.0.1","::1","[::1]"].includes(parsed.hostname.toLowerCase());
 if((parsed.protocol!=="https:"&&!(local&&parsed.protocol==="http:"))||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error("Publication audit URL must use HTTPS and contain no credentials, query or fragment.");
 return parsed.origin;
}
export function createCloudPublicationAuditApi({
 url=process.env.SUPABASE_URL,
 serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,
 adminEmails=process.env.PUBLICATION_AUDIT_ADMIN_EMAILS||"",
 authorize,
 fetchImpl=globalThis.fetch,
 timeoutMs=10000
}={}){
 if(!url||!serviceRoleKey)throw new Error("Cloud publication audit API requires server-side Supabase credentials.");
 if(typeof authorize!=="function")throw new Error("Cloud publication audit API requires an explicit project authorization function.");
 if(typeof fetchImpl!=="function")throw new Error("Cloud publication audit API requires fetch.");
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>60000)throw new Error("Cloud publication audit API timeout is invalid.");
 const base=safeUrl(url);
 const admins=new Set(String(adminEmails).split(",").map(x=>x.trim().toLowerCase()).filter(Boolean));
 async function queryRows(params){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const response=await fetchImpl(base+"/rest/v1/publication_cleanup_audit_events?"+params.toString(),{
    method:"GET",
    headers:{apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,"accept-profile":"executive_visuals",accept:"application/json"},
    signal:controller.signal
   });
   if(!response.ok)throw new Error("Publication audit storage query failed (HTTP "+response.status+").");
   const rows=await response.json();
   if(!Array.isArray(rows))throw new Error("Publication audit storage returned an invalid response.");
   return rows;
  }catch(error){
   if(error?.name==="AbortError")throw new Error("Publication audit storage query timed out.");
   throw error;
  }finally{clearTimeout(timer);}
 }
 async function checkReadiness(){
  const params=new URLSearchParams({select:"id",limit:"0"});
  await queryRows(params);
  return true;
 }
 async function handle({method,path,user,query={}}={}){
  if(path!=="/api/cloud/publication-audit")return null;
  if(method!=="GET")return{status:405,body:{error:{code:"METHOD_NOT_ALLOWED",message:"Publication audit history is read-only."}}};
  if(!user?.id||!user?.email)return{status:401,body:{error:{code:"AUTH_REQUIRED",message:"Sign in with a verified account."}}};
  if(user.emailVerified!==true||!admins.has(String(user.email).toLowerCase()))return{status:403,body:{error:{code:"PUBLICATION_AUDIT_ADMIN_REQUIRED",message:"An explicitly allowlisted publication-audit administrator is required."}}};
  try{
   const projectId=safeUuid(query.projectId,"project ID");
   const jobId=safeUuid(query.jobId,"job ID");
   const runId=safeUuid(query.runId,"run ID");
   const actorId=safeUuid(query.actorId,"actor ID");
   const limit=safeLimit(query.limit);
   const cursor=decodeCursor(query.cursor);
   const eventType=query.eventType||null;
   if(eventType&&!EVENT_TYPES.has(eventType))throw new Error("Publication audit event type is not allowed.");
   const from=query.from?parseDate(query.from,"from timestamp"):null;
   const to=query.to?parseDate(query.to,"to timestamp"):null;
   if(from&&to&&Date.parse(from)>Date.parse(to))throw new Error("Publication audit from timestamp must not be later than to timestamp.");
   if(projectId){
    const allowed=await authorize({ownerId:user.id,projectId,action:"read"});
    if(!allowed)return{status:404,body:{error:{code:"PROJECT_NOT_FOUND",message:"Project not found or audit access is not permitted."}}};
   }
   const params=new URLSearchParams({
    select:FIELDS,
    order:"occurred_at.desc,id.desc",
    limit:String(limit+1)
   });
   if(projectId)params.set("project_id","eq."+projectId);
   else {params.set("owner_id","eq."+user.id);params.set("project_id","is.null");}
   if(jobId)params.set("job_id","eq."+jobId);
   if(runId)params.set("run_id","eq."+runId);
   if(actorId)params.set("actor_id","eq."+actorId);
   if(eventType)params.set("event_type","eq."+eventType);
   if(from&&to)params.set("and","(occurred_at.gte."+from+",occurred_at.lte."+to+")");
   else if(from)params.set("occurred_at","gte."+from);
   else if(to)params.set("occurred_at","lte."+to);
   if(cursor)params.set("or","(occurred_at.lt."+cursor.at+",and(occurred_at.eq."+cursor.at+",id.lt."+cursor.id+"))");
   const rows=await queryRows(params);
   const page=rows.slice(0,limit);
   const nextCursor=rows.length>limit&&page.length?encodeCursor(page[page.length-1]):null;
   return{status:200,body:{events:page,nextCursor,hasMore:Boolean(nextCursor),limit,readOnly:true}};
  }catch(error){
   const message=String(error?.message||"Publication audit query failed.");
   const invalid=/must be|is invalid|not allowed|not be later/.test(message);
   return{status:invalid?400:503,body:{error:{code:invalid?"INVALID_AUDIT_QUERY":"PUBLICATION_AUDIT_UNAVAILABLE",message:invalid?message:"Publication audit history is temporarily unavailable."}}};
  }
 }
 return Object.freeze({handle,checkReadiness});
}
