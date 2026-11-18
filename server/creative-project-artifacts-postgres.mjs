import { createHash, randomUUID } from "node:crypto";
import { validateEditedStoryboard } from "./creative-project-artifacts.mjs";

const SCHEMA="executive_visuals";
const TYPES=new Set(["creative_direction","storyboard"]);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isObject=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const stable=value=>Array.isArray(value)?"["+value.map(stable).join(",")+"]":isObject(value)?"{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+stable(value[key])).join(",")+"}":(JSON.stringify(value)??"null");
const hash=value=>createHash("sha256").update(value,"utf8").digest("hex");
const fail=(message,code)=>Object.assign(new Error(message),{code});

function baseUrl(value){
 let url;try{url=new URL(value);}catch{throw new Error("Creative artifact Postgres URL must be absolute.");}
 const local=["localhost","127.0.0.1","::1","[::1]"].includes(url.hostname.toLowerCase());
 if((url.protocol!=="https:"&&!(local&&url.protocol==="http:"))||url.username||url.password||url.search||url.hash)throw new Error("Creative artifact Postgres URL must use HTTPS and contain no credentials, query or fragment.");
 return url.origin;
}
function map(row){
 if(!row)return null;
 return {id:row.id,projectId:row.project_id,createdBy:row.created_by,type:row.artifact_type,
  revision:Number(row.revision),inputHash:row.input_hash,contentHash:row.content_hash,
  input:row.input||{},content:row.content||{},model:row.model||null,usage:row.usage||{},
  createdAt:row.created_at};
}
function boundedObject(value,label){
 if(!isObject(value))throw fail(label+" must be a JSON object.","CREATIVE_ARTIFACT_INVALID");
 const json=stable(value);
 if(Buffer.byteLength(json,"utf8")>512*1024)throw fail(label+" exceeds the 512 KiB artifact limit.","CREATIVE_ARTIFACT_TOO_LARGE");
 return value;
}
export function createCloudCreativeProjectArtifactRepository({
 url=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,
 fetchImpl=globalThis.fetch,timeoutMs=15000
}={}){
 if(!url||!serviceRoleKey||typeof fetchImpl!=="function")throw new Error("Cloud creative artifacts require server-side Supabase credentials and fetch.");
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw new Error("Creative artifact repository timeout is invalid.");
 const base=baseUrl(url);
 async function request(path,{method="GET",body=null,prefer="return=representation"}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const headers={apikey:serviceRoleKey,"accept-profile":SCHEMA,"content-profile":SCHEMA,accept:"application/json",prefer};
   if(!String(serviceRoleKey).startsWith("sb_secret_"))headers.authorization="Bearer "+serviceRoleKey;
   if(body!==null)headers["content-type"]="application/json";
   const response=await fetchImpl(base+"/rest/v1/"+path,{method,headers,...(body===null?{}:{body:JSON.stringify(body)}),signal:controller.signal});
   const raw=await response.text();let data=null;
   if(raw){try{data=JSON.parse(raw);}catch{throw fail("Creative artifact database returned invalid JSON.","CREATIVE_ARTIFACT_DATABASE_INVALID_RESPONSE");}}
   if(!response.ok){
    const code=String(data?.code||"");
    const message=String(data?.message||"Creative artifact database request failed.").replaceAll(serviceRoleKey,"[redacted]").slice(0,300);
    if(code==="23503"||/CREATIVE_ARTIFACT_PROJECT_NOT_FOUND/.test(message))throw fail("Cloud project must exist before its creative artifacts can be saved.","CREATIVE_ARTIFACT_PROJECT_NOT_FOUND");
    if(code==="42501"||/CREATIVE_ARTIFACT_EDITOR_REQUIRED/.test(message))throw fail("The cloud project does not grant this user editor access.","CREATIVE_ARTIFACT_EDITOR_REQUIRED");
    throw fail(message,"CREATIVE_ARTIFACT_DATABASE_HTTP_"+response.status);
   }
   return data;
  }catch(error){if(error?.name==="AbortError")throw fail("Creative artifact database request timed out.","CREATIVE_ARTIFACT_DATABASE_TIMEOUT");throw error;}
  finally{clearTimeout(timer);}
 }
 async function ensureProject({projectId,ownerId,name,description=""}={}){
  if(!UUID.test(String(projectId||""))||!UUID.test(String(ownerId||"")))throw fail("Cloud project and owner IDs must be UUIDs.","CREATIVE_ARTIFACT_PROJECT_REQUIRED");
  const query="projects?select=id,owner_id,archived_at&id=eq."+encodeURIComponent(projectId)+"&limit=1";
  let rows=await request(query),row=Array.isArray(rows)?rows[0]:null;
  if(!row){
   if(typeof name!=="string"||!name.trim()||name.trim().length>160)throw fail("A valid local project name is required to provision its cloud record.","CREATIVE_ARTIFACT_PROJECT_REQUIRED");
   try{
    rows=await request("projects?select=id,owner_id,archived_at",{method:"POST",body:{id:projectId,owner_id:ownerId,name:name.trim(),description:typeof description==="string"?description.slice(0,4000):"",settings:{}}});
    row=Array.isArray(rows)?rows[0]:null;
   }catch(error){
    if(!String(error.code||"").includes("409")&&!String(error.message||"").includes("duplicate"))throw error;
    rows=await request(query);row=Array.isArray(rows)?rows[0]:null;
   }
  }
  if(!row||row.id!==projectId||row.owner_id!==ownerId||row.archived_at)throw fail("Cloud project identity does not match the local project owner or is archived.","CREATIVE_ARTIFACT_PROJECT_SCOPE_MISMATCH");
  return row;
 }
 async function get({projectId,artifactId}={}){
  if(!UUID.test(String(projectId||""))||!UUID.test(String(artifactId||"")))return null;
  const rows=await request("creative_project_artifacts?select=*&project_id=eq."+encodeURIComponent(projectId)+"&id=eq."+encodeURIComponent(artifactId)+"&limit=1");
  if(!Array.isArray(rows)||rows.length>1)throw fail("Creative artifact lookup returned an invalid result.","CREATIVE_ARTIFACT_DATABASE_INVALID_RESPONSE");
  return map(rows[0]||null);
 }
 async function list({projectId,type=null,limit=20}={}){
  if(!UUID.test(String(projectId||"")))throw fail("A valid project ID is required.","CREATIVE_ARTIFACT_QUERY_INVALID");
  if(type!==null&&!TYPES.has(type))throw fail("Unsupported creative project artifact type.","CREATIVE_ARTIFACT_TYPE_INVALID");
  const boundedLimit=Number.isInteger(Number(limit))?Math.max(1,Math.min(100,Number(limit))):20;
  let query="creative_project_artifacts?select=*&project_id=eq."+encodeURIComponent(projectId);
  if(type)query+="&artifact_type=eq."+encodeURIComponent(type);
  query+="&order=created_at.desc,id.desc&limit="+boundedLimit;
  const rows=await request(query);
  if(!Array.isArray(rows))throw fail("Creative artifact list returned an invalid result.","CREATIVE_ARTIFACT_DATABASE_INVALID_RESPONSE");
  return rows.map(map);
 }
 async function append({id=null,projectId,ownerId,projectName,projectDescription="",createdBy,type,input,content,inputHash,model=null,usage={},skipProjectEnsure=false}={}){
  if(!UUID.test(String(projectId||""))||!UUID.test(String(ownerId||""))||!UUID.test(String(createdBy||"")))throw fail("Project, owner and creator UUIDs are required.","CREATIVE_ARTIFACT_PROJECT_REQUIRED");
  if(id!==null&&!UUID.test(String(id)))throw fail("Creative artifact ID must be a UUID.","CREATIVE_ARTIFACT_INVALID");
  if(!TYPES.has(type))throw fail("Unsupported creative project artifact type.","CREATIVE_ARTIFACT_TYPE_INVALID");
  if(!/^[a-f0-9]{64}$/i.test(String(inputHash||"")))throw fail("A verified SHA-256 input hash is required.","CREATIVE_ARTIFACT_INPUT_HASH_INVALID");
  boundedObject(input,"Creative artifact input");boundedObject(content,"Creative artifact content");boundedObject(isObject(usage)?usage:{},"Creative artifact usage");
  if(!skipProjectEnsure)await ensureProject({projectId,ownerId,name:projectName,description:projectDescription});
  const rows=await request("rpc/append_creative_project_artifact",{method:"POST",body:{
   p_id:id||randomUUID(),p_project_id:projectId,p_created_by:createdBy,p_artifact_type:type,
   p_input_hash:inputHash.toLowerCase(),p_content_hash:hash(stable(content)),
   p_input:input,p_content:content,p_model:typeof model==="string"?model.trim().slice(0,200)||null:null,p_usage:isObject(usage)?usage:{}
  }});
  if(!Array.isArray(rows)||rows.length!==1)throw fail("Atomic creative artifact append was not confirmed.","CREATIVE_ARTIFACT_PERSISTENCE_FAILED");
  return map(rows[0]);
 }
 return Object.freeze({
  save:append,
  get,list,
  async checkReadiness(){
   const rows=await request("creative_project_artifacts?select=id&limit=0");
   if(!Array.isArray(rows))throw fail("Creative artifact readiness query returned an invalid result.","CREATIVE_ARTIFACT_DATABASE_INVALID_RESPONSE");
   return {backend:"supabase-postgres",configured:true,ready:true,durableAcrossDeploys:true};
  },
  async importLegacyArtifacts({projectId,ownerId,projectName,projectDescription="",artifacts=[]}={}){
   if(!Array.isArray(artifacts)||artifacts.length>10000)throw fail("Legacy artifact batch is invalid or too large.","CREATIVE_ARTIFACT_IMPORT_INVALID");
   await ensureProject({projectId,ownerId,name:projectName,description:projectDescription});
   const ordered=[...artifacts].sort((a,b)=>String(a.type).localeCompare(String(b.type))||Number(a.revision)-Number(b.revision));
   let imported=0,alreadyPresent=0;
   for(const source of ordered){
    if(!source||!UUID.test(String(source.id||""))||source.projectId!==projectId||!TYPES.has(source.type))throw fail("Legacy artifact identity is invalid.","CREATIVE_ARTIFACT_IMPORT_INVALID");
    const existing=await get({projectId,artifactId:source.id});
    if(existing){
     if(existing.type!==source.type||existing.revision!==Number(source.revision)||existing.inputHash!==source.inputHash||existing.contentHash!==source.contentHash)throw fail("A cloud artifact conflicts with the legacy artifact ID or revision.","CREATIVE_ARTIFACT_IMPORT_CONFLICT");
     alreadyPresent++;continue;
    }
    const cloud=await list({projectId,type:source.type,limit:100});
    const maxRevision=cloud.reduce((max,item)=>Math.max(max,item.revision),0);
    if(Number(source.revision)!==maxRevision+1)throw fail("Legacy artifact revisions are not contiguous with cloud history; automatic import stopped without overwriting data.","CREATIVE_ARTIFACT_IMPORT_CONFLICT");
    let saved;
    try{
     saved=await append({id:source.id,projectId,ownerId,createdBy:source.createdBy,projectName,projectDescription,type:source.type,input:source.input,content:source.content,inputHash:source.inputHash,model:source.model,usage:source.usage,skipProjectEnsure:true});
    }catch(error){
     // Another app instance may have imported this exact immutable row first.
     const raced=await get({projectId,artifactId:source.id});
     if(!raced||raced.type!==source.type||raced.revision!==Number(source.revision)||raced.inputHash!==source.inputHash||raced.contentHash!==source.contentHash)throw error;
     alreadyPresent++;continue;
    }
    if(saved.revision!==Number(source.revision)||saved.contentHash!==source.contentHash)throw fail("Imported artifact did not preserve its source revision and content hash.","CREATIVE_ARTIFACT_IMPORT_CONFLICT");
    imported++;
   }
   return {imported,alreadyPresent,total:ordered.length};
  },
  async appendRevision({projectId,ownerId,projectName,projectDescription="",createdBy,artifactId,content}={}){
   const parent=await get({projectId,artifactId});
   if(!parent)throw fail("Source creative artifact not found.","CREATIVE_ARTIFACT_NOT_FOUND");
   if(parent.type!=="storyboard")throw fail("Only storyboard artifacts support edited revisions.","CREATIVE_ARTIFACT_TYPE_INVALID");
   validateEditedStoryboard(content,parent.inputHash);
   if(hash(stable(content))===parent.contentHash)return {...parent,unchanged:true};
   return append({projectId,ownerId,projectName,projectDescription,createdBy,type:"storyboard",input:parent.input,content,inputHash:parent.inputHash,model:parent.model,usage:parent.usage});
  }
 });
}
