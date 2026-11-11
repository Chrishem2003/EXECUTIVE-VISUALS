import { randomUUID } from "node:crypto";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validId=(value,label)=>{if(typeof value!=="string"||!UUID.test(value))throw new Error(label+" must be a UUID.");return value;};
const map=row=>({id:row.id,ownerId:row.owner_id,name:row.name,description:row.description||"",settings:row.settings||{},revision:Number(row.revision),createdAt:row.created_at,updatedAt:row.updated_at,archivedAt:row.archived_at||null});

export function createCloudProjectRepository({url=process.env.SUPABASE_URL,serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl=globalThis.fetch,authorize,timeoutMs=12000}={}){
 if(!url||!serviceRoleKey||typeof fetchImpl!=="function"||typeof authorize!=="function")throw new Error("Cloud project repository requires credentials, fetch and authorization.");
 const base=new URL(url).origin;
 async function request(path,{method="GET",body=null}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
   const headers={apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,"accept-profile":"executive_visuals","content-profile":"executive_visuals",accept:"application/json",prefer:"return=representation"};
   if(body!==null)headers["content-type"]="application/json";
   const res=await fetchImpl(base+"/rest/v1/"+path,{method,headers,...(body===null?{}:{body:JSON.stringify(body)}),signal:controller.signal});
   const raw=await res.text();let data=null;if(raw){try{data=JSON.parse(raw);}catch{throw new Error("Cloud project service returned invalid database data.");}}
   if(!res.ok){const e=new Error("Cloud project database request failed (HTTP "+res.status+").");e.status=res.status;e.code="CLOUD_PROJECT_DATABASE_ERROR";throw e;}
   return data;
  }catch(e){if(e?.name==="AbortError"){const x=new Error("Cloud project database request timed out.");x.code="CLOUD_PROJECT_TIMEOUT";throw x;}throw e;}
  finally{clearTimeout(timer);}
 }
 async function allowed(ownerId,projectId,action){if(await authorize({ownerId,projectId,action})!==true){const e=new Error("Cloud project access denied.");e.code="CLOUD_PROJECT_ACCESS_DENIED";throw e;}}
 async function get({ownerId,projectId}){validId(ownerId,"Owner ID");validId(projectId,"Project ID");const rows=await request("projects?select=id,owner_id,name,description,settings,revision,created_at,updated_at,archived_at&id=eq."+encodeURIComponent(projectId)+"&archived_at=is.null&limit=1");const row=Array.isArray(rows)?rows[0]:null;if(!row)return null;await allowed(ownerId,projectId,"read");return map(row);}
 return Object.freeze({
  async create({ownerId,projectId=null,name,description="",settings={}}={}){
   validId(ownerId,"Owner ID");if(projectId!==null)validId(projectId,"Project ID");
   if(typeof name!=="string"||!name.trim()||name.trim().length>160)throw new Error("Project name must contain 1–160 characters.");
   if(typeof description!=="string"||description.length>4000)throw new Error("Project description is too long.");
   if(!settings||typeof settings!=="object"||Array.isArray(settings))throw new Error("Project settings must be an object.");
   const select="projects?select=id,owner_id,name,description,settings,revision,created_at,updated_at,archived_at";
   if(projectId){
    const existing=await request(select+"&id=eq."+encodeURIComponent(projectId)+"&limit=1");
    const row=Array.isArray(existing)?existing[0]:null;
    if(row){
     if(row.owner_id!==ownerId)throw Object.assign(new Error("Cloud project ID is not available to this account."),{code:"CLOUD_PROJECT_ACCESS_DENIED"});
     if(row.archived_at)throw Object.assign(new Error("An archived cloud project cannot be linked to an active local project."),{code:"CLOUD_PROJECT_ARCHIVED"});
     await allowed(ownerId,projectId,"read");
     return map(row);
    }
   }
   const id=projectId||randomUUID();
   try{
    const rows=await request(select,{method:"POST",body:{id,owner_id:ownerId,name:name.trim(),description,settings}});
    if(!Array.isArray(rows)||rows.length!==1||rows[0].owner_id!==ownerId||rows[0].id!==id)throw new Error("Cloud project creation returned an invalid record.");
    return map(rows[0]);
   }catch(error){
    if(!projectId)throw error;
    const raced=await request(select+"&id=eq."+encodeURIComponent(projectId)+"&limit=1");
    const row=Array.isArray(raced)?raced[0]:null;
    if(row&&row.owner_id===ownerId&&!row.archived_at){await allowed(ownerId,projectId,"read");return map(row);}
    throw error;
   }
  },
  async list({ownerId,limit=50,offset=0}={}){
   validId(ownerId,"Owner ID");limit=Math.max(1,Math.min(100,Number.isInteger(limit)?limit:50));offset=Math.max(0,Math.min(100000,Number.isInteger(offset)?offset:0));
   const [owned,memberships]=await Promise.all([
    request("projects?select=id,owner_id,name,description,settings,revision,created_at,updated_at,archived_at&owner_id=eq."+encodeURIComponent(ownerId)+"&archived_at=is.null&order=updated_at.desc&limit="+limit+"&offset="+offset),
    request("project_members?select=project_id&member_id=eq."+encodeURIComponent(ownerId)+"&order=created_at.desc&limit="+limit+"&offset="+offset)
   ]);
   const ids=[...new Set((Array.isArray(memberships)?memberships:[]).map(x=>x.project_id).filter(x=>UUID.test(x)))];
   let shared=[];
   if(ids.length)shared=await request("projects?select=id,owner_id,name,description,settings,revision,created_at,updated_at,archived_at&id=in.("+ids.map(encodeURIComponent).join(",")+")&archived_at=is.null");
   const rows=[...(Array.isArray(owned)?owned:[]),...(Array.isArray(shared)?shared:[])];
   const unique=[...new Map(rows.map(row=>[row.id,row])).values()].sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at))).slice(0,limit);
   const authorized=[];for(const row of unique){if(await authorize({ownerId,projectId:row.id,action:"read"})===true)authorized.push(map(row));}
   return authorized;
  },
  get,
  async update({ownerId,projectId,expectedRevision,name,description,settings}={}){
   const current=await get({ownerId,projectId});if(!current){const e=new Error("Cloud project not found.");e.code="CLOUD_PROJECT_NOT_FOUND";throw e;}
   await allowed(ownerId,projectId,"write");if(!Number.isInteger(expectedRevision)||expectedRevision!==current.revision){const e=new Error("Cloud project revision changed.");e.code="CLOUD_PROJECT_REVISION_CONFLICT";throw e;}
   const patch={revision:expectedRevision+1,updated_at:new Date().toISOString()};
   if(name!==undefined){if(typeof name!=="string"||!name.trim()||name.trim().length>160)throw new Error("Project name must contain 1–160 characters.");patch.name=name.trim();}
   if(description!==undefined){if(typeof description!=="string"||description.length>4000)throw new Error("Project description is too long.");patch.description=description;}
   if(settings!==undefined){if(!settings||typeof settings!=="object"||Array.isArray(settings))throw new Error("Project settings must be an object.");patch.settings=settings;}
   const rows=await request("projects?id=eq."+encodeURIComponent(projectId)+"&revision=eq."+expectedRevision+"&archived_at=is.null",{method:"PATCH",body:patch});
   if(!Array.isArray(rows)||rows.length!==1){const e=new Error("Cloud project revision changed.");e.code="CLOUD_PROJECT_REVISION_CONFLICT";throw e;}return map(rows[0]);
  },
  async archive({ownerId,projectId,expectedRevision}={}){
   const current=await get({ownerId,projectId});if(!current){const e=new Error("Cloud project not found.");e.code="CLOUD_PROJECT_NOT_FOUND";throw e;}if(current.ownerId!==ownerId){const e=new Error("Only the project owner can archive this project.");e.code="CLOUD_PROJECT_ACCESS_DENIED";throw e;}await allowed(ownerId,projectId,"write");
   if(expectedRevision!==current.revision){const e=new Error("Cloud project revision changed.");e.code="CLOUD_PROJECT_REVISION_CONFLICT";throw e;}
   const rows=await request("projects?id=eq."+encodeURIComponent(projectId)+"&owner_id=eq."+encodeURIComponent(current.ownerId)+"&revision=eq."+expectedRevision+"&archived_at=is.null",{method:"PATCH",body:{archived_at:new Date().toISOString(),revision:expectedRevision+1,updated_at:new Date().toISOString()}});
   if(!Array.isArray(rows)||rows.length!==1){const e=new Error("Cloud project revision changed.");e.code="CLOUD_PROJECT_REVISION_CONFLICT";throw e;}return{id:projectId,archived:true,revision:Number(rows[0].revision)};
  }
 });
}
