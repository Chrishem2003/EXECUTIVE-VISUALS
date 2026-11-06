import { createHash, randomUUID } from "node:crypto";
import { buildCloudAssetObjectPath } from "./cloud-storage.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTENSIONS = new Map([
  ["image/jpeg","jpg"],["image/png","png"],["image/webp","webp"],["image/gif","gif"],
  ["video/mp4","mp4"],["video/webm","webm"],["video/quicktime","mov"],["video/x-matroska","mkv"],
  ["audio/mpeg","mp3"],["audio/wav","wav"],["audio/x-wav","wav"],["audio/mp4","m4a"],["audio/ogg","ogg"],
  ["application/pdf","pdf"],["text/plain","txt"],["text/vtt","vtt"],["application/json","json"]
]);

function validUuid(value,label) {
  const text=String(value||"");
  if(!UUID.test(text)) throw new Error("Cloud asset "+label+" must be a valid UUID.");
  return text;
}
function plainObject(value) {
  return value!==null && typeof value==="object" && !Array.isArray(value);
}
function safeName(value) {
  const name=String(value||"upload").normalize("NFKC").replace(/[\\/\u0000-\u001f\u007f]/g,"_").replace(/[^\p{L}\p{N}._() -]/gu,"_").trim().slice(0,180);
  return name||"upload";
}
function publicAsset(row) {
  return {
    id:row.id,ownerId:row.owner_id,projectId:row.project_id||null,name:row.original_name,
    mediaType:row.media_type,size:Number(row.byte_size),sha256:row.sha256,
    storageBucket:row.storage_bucket,objectPath:row.object_path,
    derivativeOf:row.derivative_of||null,metadata:row.metadata||{},createdAt:row.created_at
  };
}

export function createCloudAssetRepository({
  url=process.env.SUPABASE_URL,
  serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY,
  storage,
  authorize,
  fetchImpl=globalThis.fetch,
  timeoutMs=15000
}={}) {
  if(!url||!serviceRoleKey) throw new Error("Cloud asset repository requires server-side Supabase credentials.");
  if(!storage||typeof storage.upload!=="function"||typeof storage.remove!=="function"||typeof storage.createSignedUrl!=="function") throw new Error("Cloud asset repository requires the private cloud storage adapter.");
  if(typeof authorize!=="function") throw new Error("Cloud asset repository requires an explicit owner/project authorization function.");
  if(typeof fetchImpl!=="function") throw new Error("Cloud asset repository requires a fetch implementation.");
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000) throw new Error("Cloud asset repository timeout is invalid.");
  let base;
  try { const parsed=new URL(url); if(parsed.protocol!=="https:"&&!["localhost","127.0.0.1","[::1]"].includes(parsed.hostname)) throw new Error(); if(parsed.username||parsed.password||parsed.search||parsed.hash) throw new Error(); base=parsed.origin; }
  catch { throw new Error("Cloud asset repository URL must be a safe absolute HTTPS URL."); }

  async function request(path,{method="GET",body=null,prefer=null}={}) {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const headers={apikey:serviceRoleKey,authorization:"Bearer "+serviceRoleKey,"accept-profile":"executive_visuals","content-profile":"executive_visuals"};
      if(body!==null) headers["content-type"]="application/json";
      if(prefer) headers.prefer=prefer;
      const response=await fetchImpl(base+"/rest/v1/"+path,{method,headers,...(body===null?{}:{body:JSON.stringify(body)}),signal:controller.signal});
      const raw=await response.text();
      let data=null;
      if(raw){try{data=JSON.parse(raw);}catch{if(response.ok)throw new Error("Cloud asset service returned an invalid response.");}}
      if(!response.ok){
        const error=new Error("Cloud asset metadata request failed (HTTP "+response.status+").");
        error.code="CLOUD_ASSET_HTTP_"+response.status;error.status=response.status;throw error;
      }
      return data;
    } catch(error) {
      if(error?.name==="AbortError"){const timeout=new Error("Cloud asset metadata request timed out.");timeout.code="CLOUD_ASSET_TIMEOUT";throw timeout;}
      throw error;
    } finally {clearTimeout(timer);}
  }

  async function allowed(ownerId,projectId,action) {
    const result=await authorize({ownerId,projectId,action});
    if(result!==true) {const error=new Error("Cloud asset access denied.");error.code="CLOUD_ASSET_ACCESS_DENIED";throw error;}
  }

  return Object.freeze({
    async create({ownerId,projectId=null,originalName,mediaType,bytes,derivativeOf=null,metadata={}}) {
      ownerId=validUuid(ownerId,"owner ID");
      if(projectId!==null&&projectId!==undefined&&projectId!=="") projectId=validUuid(projectId,"project ID"); else projectId=null;
      if(derivativeOf!==null&&derivativeOf!==undefined) derivativeOf=validUuid(derivativeOf,"derivative ID"); else derivativeOf=null;
      if(!EXTENSIONS.has(mediaType)) throw new Error("Unsupported cloud asset media type.");
      if(!(bytes instanceof Uint8Array)||bytes.byteLength<1) throw new Error("Cloud asset bytes must be a non-empty Uint8Array.");
      if(!plainObject(metadata)) throw new Error("Cloud asset metadata must be a JSON object.");
      if(JSON.stringify(metadata).length>16000) throw new Error("Cloud asset metadata exceeds the 16 KB limit.");
      await allowed(ownerId,projectId,"write");
      const id=randomUUID(),name=safeName(originalName),sha256=createHash("sha256").update(bytes).digest("hex");
      const objectPath=buildCloudAssetObjectPath({ownerId,projectId,assetId:id,filename:"original."+EXTENSIONS.get(mediaType)});
      const uploaded=await storage.upload(objectPath,bytes,mediaType);
      if(uploaded?.bucket!=="executive-visuals-media"||uploaded?.path!==objectPath||uploaded?.size!==bytes.byteLength){try{await storage.remove(objectPath);}catch{}throw new Error("Cloud storage returned an unexpected upload receipt.");}
      try {
        const rows=await request("assets?select=id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,derivative_of,metadata,created_at",{
          method:"POST",prefer:"return=representation",
          body:{id,owner_id:ownerId,project_id:projectId,original_name:name,media_type:mediaType,byte_size:bytes.byteLength,sha256,storage_bucket:uploaded.bucket,object_path:objectPath,derivative_of:derivativeOf,metadata}
        });
        if(!Array.isArray(rows)||rows.length!==1||rows[0].id!==id||rows[0].owner_id!==ownerId||rows[0].project_id!==projectId||rows[0].object_path!==objectPath||rows[0].storage_bucket!=="executive-visuals-media"||Number(rows[0].byte_size)!==bytes.byteLength||rows[0].sha256!==sha256) throw new Error("Cloud asset metadata insert did not return the expected record.");
        return publicAsset(rows[0]);
      } catch(error) {
        try { await storage.remove(objectPath); }
        catch { error.cleanupPending=true; }
        throw error;
      }
    },
    async createFromFile({ownerId,projectId=null,originalName,mediaType,filePath,derivativeOf=null,metadata={}}) {
      ownerId=validUuid(ownerId,"owner ID");
      if(projectId!==null&&projectId!==undefined&&projectId!=="")projectId=validUuid(projectId,"project ID");else projectId=null;
      if(derivativeOf!==null&&derivativeOf!==undefined)derivativeOf=validUuid(derivativeOf,"derivative ID");else derivativeOf=null;
      if(!EXTENSIONS.has(mediaType))throw new Error("Unsupported cloud asset media type.");
      if(typeof filePath!=="string"||!filePath)throw new Error("Cloud asset file path is required.");
      if(!plainObject(metadata))throw new Error("Cloud asset metadata must be a JSON object.");
      if(JSON.stringify(metadata).length>16000)throw new Error("Cloud asset metadata exceeds the 16 KB limit.");
      if(typeof storage.uploadFile!=="function")throw new Error("Cloud storage adapter does not support streaming file uploads.");
      await allowed(ownerId,projectId,"write");
      const id=randomUUID(),name=safeName(originalName),objectPath=buildCloudAssetObjectPath({ownerId,projectId,assetId:id,filename:"original."+EXTENSIONS.get(mediaType)});
      const uploaded=await storage.uploadFile(objectPath,filePath,mediaType);
      if(uploaded?.bucket!=="executive-visuals-media"||uploaded?.path!==objectPath||!Number.isSafeInteger(uploaded?.size)||uploaded.size<1||typeof uploaded?.sha256!=="string"||!/^[a-f0-9]{64}$/i.test(uploaded.sha256)){
        try{await storage.remove(objectPath);}catch{}
        throw new Error("Cloud storage returned an unexpected streaming upload receipt.");
      }
      try{
        const rows=await request("assets?select=id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,derivative_of,metadata,created_at",{
          method:"POST",prefer:"return=representation",
          body:{id,owner_id:ownerId,project_id:projectId,original_name:name,media_type:mediaType,byte_size:uploaded.size,sha256:uploaded.sha256,storage_bucket:uploaded.bucket,object_path:objectPath,derivative_of:derivativeOf,metadata}
        });
        if(!Array.isArray(rows)||rows.length!==1||rows[0].id!==id||rows[0].owner_id!==ownerId||rows[0].project_id!==projectId||rows[0].object_path!==objectPath||rows[0].storage_bucket!=="executive-visuals-media"||Number(rows[0].byte_size)!==uploaded.size||rows[0].sha256!==uploaded.sha256)throw new Error("Cloud asset metadata insert did not return the expected streaming record.");
        return publicAsset(rows[0]);
      }catch(error){
        try{await storage.remove(objectPath);}catch{error.cleanupPending=true;}
        throw error;
      }
    },
    async list({ownerId,projectId=null,limit=50,offset=0}={}) {
      ownerId=validUuid(ownerId,"owner ID");
      if(projectId!==null&&projectId!==undefined&&projectId!=="")projectId=validUuid(projectId,"project ID");else projectId=null;
      limit=Math.max(1,Math.min(100,Number.isInteger(limit)?limit:50));
      offset=Math.max(0,Math.min(100000,Number.isInteger(offset)?offset:0));
      await allowed(ownerId,projectId,"read");
      const scope=projectId?"project_id=eq."+encodeURIComponent(projectId):"owner_id=eq."+encodeURIComponent(ownerId)+"&project_id=is.null";
      const rows=await request("assets?select=id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,derivative_of,metadata,created_at,deleted_at&"+scope+"&deleted_at=is.null&order=created_at.desc&limit="+limit+"&offset="+offset);
      return (Array.isArray(rows)?rows:[]).map(publicAsset);
    },
    async get({ownerId,assetId}) {
      ownerId=validUuid(ownerId,"owner ID");assetId=validUuid(assetId,"asset ID");
      const rows=await request("assets?select=id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,derivative_of,metadata,created_at,deleted_at&id=eq."+encodeURIComponent(assetId)+"&deleted_at=is.null&limit=1");
      const row=Array.isArray(rows)?rows[0]:null;
      if(!row||(!row.project_id&&row.owner_id!==ownerId)){const error=new Error("Cloud asset not found.");error.code="CLOUD_ASSET_NOT_FOUND";throw error;}
      await allowed(ownerId,row.project_id||null,"read");
      return publicAsset(row);
    },
    async updateMetadata({ownerId,assetId,patch}={}) {
      ownerId=validUuid(ownerId,"owner ID");assetId=validUuid(assetId,"asset ID");
      if(!patch||typeof patch!=="object"||Array.isArray(patch))throw new Error("Cloud asset metadata patch must be an object.");
      const rows=await request("assets?select=id,owner_id,project_id,metadata&id=eq."+encodeURIComponent(assetId)+"&deleted_at=is.null&limit=1");
      const row=Array.isArray(rows)?rows[0]:null;
      if(!row||(!row.project_id&&row.owner_id!==ownerId)){const error=new Error("Cloud asset not found.");error.code="CLOUD_ASSET_NOT_FOUND";throw error;}
      await allowed(ownerId,row.project_id||null,"write");
      const metadata={...(row.metadata||{}),...patch};
      if(JSON.stringify(metadata).length>16000)throw new Error("Cloud asset metadata exceeds the 16 KB limit.");
      const changed=await request("assets?id=eq."+encodeURIComponent(assetId)+"&deleted_at=is.null",{method:"PATCH",body:{metadata}});
      if(!Array.isArray(changed)||changed.length!==1||changed[0].id!==assetId||changed[0].owner_id!==row.owner_id||changed[0].project_id!==row.project_id)throw new Error("Cloud asset metadata update did not return the expected asset.");
      return publicAsset(changed[0]);
    },
    async createSignedUrl({ownerId,assetId,expiresIn=300}) {
      ownerId=validUuid(ownerId,"owner ID");assetId=validUuid(assetId,"asset ID");
      const rows=await request("assets?select=id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,derivative_of,metadata,created_at,deleted_at&id=eq."+encodeURIComponent(assetId)+"&deleted_at=is.null&limit=1");
      const row=Array.isArray(rows)?rows[0]:null;
      if(!row||(!row.project_id&&row.owner_id!==ownerId)) {const error=new Error("Cloud asset not found.");error.code="CLOUD_ASSET_NOT_FOUND";throw error;}
      await allowed(ownerId,row.project_id||null,"read");
      const expectedPrefix=(row.project_id||row.owner_id)+"/"+row.id+"/";
      if(row.storage_bucket!=="executive-visuals-media"||typeof row.object_path!=="string"||!row.object_path.startsWith(expectedPrefix)) throw new Error("Cloud asset storage reference is invalid.");
      return {asset:publicAsset(row),url:await storage.createSignedUrl(row.object_path,expiresIn)};
    },
    async softDelete({ownerId,assetId}) {
      ownerId=validUuid(ownerId,"owner ID");assetId=validUuid(assetId,"asset ID");
      const rows=await request("assets?select=id,owner_id,project_id,object_path,storage_bucket,media_type,sha256&id=eq."+encodeURIComponent(assetId)+"&deleted_at=is.null&limit=1");
      const row=Array.isArray(rows)?rows[0]:null;
      if(!row||(!row.project_id&&row.owner_id!==ownerId)) {const error=new Error("Cloud asset not found.");error.code="CLOUD_ASSET_NOT_FOUND";throw error;}
      await allowed(ownerId,row.project_id||null,"write");
      const expectedPrefix=(row.project_id||row.owner_id)+"/"+row.id+"/";
      if(row.storage_bucket!=="executive-visuals-media"||typeof row.object_path!=="string"||!row.object_path.startsWith(expectedPrefix)) throw new Error("Cloud asset storage reference is invalid.");
      const changed=await request("assets?id=eq."+encodeURIComponent(assetId)+"&deleted_at=is.null",{method:"PATCH",prefer:"return=representation",body:{deleted_at:new Date().toISOString()}});
      if(!Array.isArray(changed)||changed.length!==1) throw new Error("Cloud asset could not be safely marked deleted.");
      const cleanupPaths=[row.object_path];
      if(String(row.media_type||"").startsWith("audio/")&&/^[a-f0-9]{64}$/i.test(String(row.sha256||""))){
        cleanupPaths.push(expectedPrefix+"waveform-v1-"+row.sha256+".png");
      }
      let storageRemoved=true;
      for(const objectPath of cleanupPaths){
        try { if(row.storage_bucket!=="executive-visuals-media") throw new Error("Unexpected cloud asset bucket."); await storage.remove(objectPath); }
        catch { storageRemoved=false; }
      }
      return {id:assetId,deleted:true,storageRemoved,cleanupPending:!storageRemoved};
    }
  });
}
