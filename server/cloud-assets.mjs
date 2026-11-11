import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
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
async function digestFile(filePath) {
  const before=await stat(filePath);
  if(!before.isFile()||before.size<1)throw new Error("Cloud asset file must be a non-empty regular file.");
  const hash=createHash("sha256");let size=0;
  for await (const chunk of createReadStream(filePath)) { size+=chunk.length;hash.update(chunk); }
  const after=await stat(filePath);
  if(size!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw new Error("Cloud asset file changed while its checksum was calculated.");
  return {size,sha256:hash.digest("hex")};
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

  function validCleanupPath(value) {
    return typeof value==="string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/original\.[a-z0-9]{1,8}$/i.test(value);
  }

  async function enqueueStorageCleanup(objectPath,reason) {
    if(!validCleanupPath(objectPath))throw new Error("Refusing to enqueue an unsafe storage cleanup path.");
    await request("asset_storage_cleanup?on_conflict=object_path",{
      method:"POST",
      prefer:"resolution=merge-duplicates,return=representation",
      body:{storage_bucket:"executive-visuals-media",object_path:objectPath,reason:String(reason||"asset_metadata_persistence_failed").slice(0,100),attempts:0,next_attempt_at:new Date().toISOString(),completed_at:null,last_error:null}
    });
  }

  async function compensateUpload(objectPath,error) {
    try { await storage.remove(objectPath); }
    catch {
      error.cleanupPending=true;
      try { await enqueueStorageCleanup(objectPath,error.code||"asset_metadata_persistence_failed"); }
      catch { error.cleanupRecordFailed=true; }
    }
    throw error;
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
      let uploaded;
      try { uploaded=await storage.upload(objectPath,bytes,mediaType); }
      catch(error) { return compensateUpload(objectPath,error); }
      if(uploaded?.bucket!=="executive-visuals-media"||uploaded?.path!==objectPath||uploaded?.size!==bytes.byteLength){
        const error=new Error("Cloud storage returned an unexpected upload receipt.");error.code="CLOUD_STORAGE_UPLOAD_RECEIPT_INVALID";
        return compensateUpload(objectPath,error);
      }
      try {
        const rows=await request("assets?select=id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,derivative_of,metadata,created_at",{
          method:"POST",prefer:"return=representation",
          body:{id,owner_id:ownerId,project_id:projectId,original_name:name,media_type:mediaType,byte_size:bytes.byteLength,sha256,storage_bucket:uploaded.bucket,object_path:objectPath,derivative_of:derivativeOf,metadata}
        });
        if(!Array.isArray(rows)||rows.length!==1||rows[0].id!==id||rows[0].owner_id!==ownerId||rows[0].project_id!==projectId||rows[0].object_path!==objectPath||rows[0].storage_bucket!=="executive-visuals-media"||Number(rows[0].byte_size)!==bytes.byteLength||rows[0].sha256!==sha256) throw new Error("Cloud asset metadata insert did not return the expected record.");
        return publicAsset(rows[0]);
      } catch(error) {
        return compensateUpload(objectPath,error);
      }
    },
    async createFromFileIdempotent({ownerId,projectId=null,originalName,mediaType,filePath,publicationKey,derivativeOf=null,metadata={}}) {
      ownerId=validUuid(ownerId,"owner ID");
      if(projectId!==null&&projectId!==undefined&&projectId!=="")projectId=validUuid(projectId,"project ID");else projectId=null;
      if(derivativeOf!==null&&derivativeOf!==undefined)derivativeOf=validUuid(derivativeOf,"derivative ID");else derivativeOf=null;
      if(!EXTENSIONS.has(mediaType))throw new Error("Unsupported cloud asset media type.");
      if(typeof filePath!=="string"||!filePath)throw new Error("Cloud asset file path is required.");
      if(typeof publicationKey!=="string"||!publicationKey.trim()||publicationKey.length>200)throw new Error("Cloud asset publication key must contain 1 to 200 characters.");
      if(!plainObject(metadata))throw new Error("Cloud asset metadata must be a JSON object.");
      if(JSON.stringify(metadata).length>16000)throw new Error("Cloud asset metadata exceeds the 16 KB limit.");
      if(typeof storage.uploadFile!=="function")throw new Error("Cloud storage adapter does not support streaming file uploads.");
      await allowed(ownerId,projectId,"write");
      const file=await digestFile(filePath),name=safeName(originalName),candidateId=randomUUID();
      const reservations=await request("rpc/reserve_asset_publication",{method:"POST",body:{p_owner_id:ownerId,p_project_id:projectId,p_publication_key:publicationKey,p_payload_sha256:file.sha256,p_asset_id:candidateId}});
      const reservation=Array.isArray(reservations)?reservations[0]:null;
      if(!reservation||reservation.owner_id!==ownerId||(reservation.project_id||null)!==projectId||reservation.publication_key!==publicationKey||reservation.payload_sha256!==file.sha256||typeof reservation.asset_id!=="string"||!UUID.test(reservation.asset_id)||!["reserved","published"].includes(reservation.status))throw new Error("Cloud asset publication reservation returned an invalid record.");
      const id=reservation.asset_id;
      const objectPath=buildCloudAssetObjectPath({ownerId,projectId,assetId:id,filename:"original."+EXTENSIONS.get(mediaType)});
      const select="id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,derivative_of,metadata,created_at,deleted_at";
      const readAsset=async()=>{const rows=await request("assets?select="+select+"&id=eq."+encodeURIComponent(id)+"&limit=1");return Array.isArray(rows)?rows[0]||null:null;};
      const verifyAsset=row=>{
        if(!row||row.id!==id||row.owner_id!==ownerId||(row.project_id||null)!==projectId||row.object_path!==objectPath||row.storage_bucket!=="executive-visuals-media"||row.media_type!==mediaType||row.derivative_of!==(derivativeOf||null)||row.deleted_at||Number(row.byte_size)!==file.size||row.sha256!==file.sha256)throw new Error("Existing publication asset does not match its reserved identity and checksum.");
        return publicAsset(row);
      };
      let existing=await readAsset();
      if(existing){
        const asset=verifyAsset(existing);
        if(reservation.status!=="published"){
          const completed=await request("rpc/complete_asset_publication",{method:"POST",body:{p_owner_id:ownerId,p_publication_key:publicationKey,p_asset_id:id}});
          if(!Array.isArray(completed)||completed.length!==1||completed[0].status!=="published")throw new Error("Existing asset could not complete its publication record.");
        }
        return asset;
      }
      if(reservation.status==="published")throw new Error("Published asset publication record is missing its asset metadata.");
      let uploaded;
      try { uploaded=await storage.uploadFile(objectPath,filePath,mediaType,{upsert:true}); }
      catch(error) { return compensateUpload(objectPath,error); }
      if(uploaded?.bucket!=="executive-visuals-media"||uploaded?.path!==objectPath||uploaded?.size!==file.size||uploaded?.sha256!==file.sha256){
        const error=new Error("Cloud storage upload did not match the reserved publication checksum.");error.code="CLOUD_STORAGE_UPLOAD_RECEIPT_INVALID";
        return compensateUpload(objectPath,error);
      }
      try{
        const rows=await request("assets?select="+select,{method:"POST",prefer:"return=representation",body:{id,owner_id:ownerId,project_id:projectId,original_name:name,media_type:mediaType,byte_size:file.size,sha256:file.sha256,storage_bucket:uploaded.bucket,object_path:objectPath,derivative_of:derivativeOf,metadata}});
        existing=Array.isArray(rows)?rows[0]||null:null;
      }catch(error){existing=await readAsset();if(!existing)return compensateUpload(objectPath,error);}
      const asset=verifyAsset(existing);
      const completed=await request("rpc/complete_asset_publication",{method:"POST",body:{p_owner_id:ownerId,p_publication_key:publicationKey,p_asset_id:id}});
      if(!Array.isArray(completed)||completed.length!==1||completed[0].status!=="published"||completed[0].asset_id!==id)throw new Error("Cloud asset publication could not be finalized.");
      return asset;
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
      let uploaded;
      try { uploaded=await storage.uploadFile(objectPath,filePath,mediaType); }
      catch(error) { return compensateUpload(objectPath,error); }
      if(uploaded?.bucket!=="executive-visuals-media"||uploaded?.path!==objectPath||!Number.isSafeInteger(uploaded?.size)||uploaded.size<1||typeof uploaded?.sha256!=="string"||!/^[a-f0-9]{64}$/i.test(uploaded.sha256)){
        const error=new Error("Cloud storage returned an unexpected streaming upload receipt.");error.code="CLOUD_STORAGE_UPLOAD_RECEIPT_INVALID";
        return compensateUpload(objectPath,error);
      }
      try{
        const rows=await request("assets?select=id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,derivative_of,metadata,created_at",{
          method:"POST",prefer:"return=representation",
          body:{id,owner_id:ownerId,project_id:projectId,original_name:name,media_type:mediaType,byte_size:uploaded.size,sha256:uploaded.sha256,storage_bucket:uploaded.bucket,object_path:objectPath,derivative_of:derivativeOf,metadata}
        });
        if(!Array.isArray(rows)||rows.length!==1||rows[0].id!==id||rows[0].owner_id!==ownerId||rows[0].project_id!==projectId||rows[0].object_path!==objectPath||rows[0].storage_bucket!=="executive-visuals-media"||Number(rows[0].byte_size)!==uploaded.size||rows[0].sha256!==uploaded.sha256)throw new Error("Cloud asset metadata insert did not return the expected streaming record.");
        return publicAsset(rows[0]);
      }catch(error){
        return compensateUpload(objectPath,error);
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
    async createSignedUrl({ownerId,assetId,expiresIn=300}) {
      if(!Number.isInteger(expiresIn)||expiresIn<30||expiresIn>3600){const error=new Error("Signed URL expiry must be between 30 and 3600 seconds.");error.code="CLOUD_ASSET_SIGNED_URL_EXPIRY_INVALID";throw error;}
      ownerId=validUuid(ownerId,"owner ID");assetId=validUuid(assetId,"asset ID");
      const rows=await request("assets?select=id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,derivative_of,metadata,created_at,deleted_at&id=eq."+encodeURIComponent(assetId)+"&deleted_at=is.null&limit=1");
      const row=Array.isArray(rows)?rows[0]:null;
      if(!row||(!row.project_id&&row.owner_id!==ownerId)) {const error=new Error("Cloud asset not found.");error.code="CLOUD_ASSET_NOT_FOUND";throw error;}
      await allowed(ownerId,row.project_id||null,"read");
      const expectedPrefix=(row.project_id||row.owner_id)+"/"+row.id+"/";
      if(row.storage_bucket!=="executive-visuals-media"||!validCleanupPath(row.object_path)||!row.object_path.startsWith(expectedPrefix)) throw new Error("Cloud asset storage reference is invalid.");
      return {asset:publicAsset(row),url:await storage.createSignedUrl(row.object_path,expiresIn)};
    },
    async findVideoGenerationOutput({ownerId,projectId=null,providerTaskId,outputIndex}={}) {
      ownerId=validUuid(ownerId,"owner ID");
      if(projectId!==null&&projectId!==undefined&&projectId!=="")projectId=validUuid(projectId,"project ID");else projectId=null;
      if(typeof providerTaskId!=="string"||!providerTaskId.trim()||providerTaskId.length>256||
         !Number.isInteger(outputIndex)||outputIndex<0||outputIndex>9)throw new Error("Provider video output lookup scope is invalid.");
      await allowed(ownerId,projectId,"read");
      const scope=projectId
        ?"owner_id=eq."+encodeURIComponent(ownerId)+"&project_id=eq."+encodeURIComponent(projectId)
        :"owner_id=eq."+encodeURIComponent(ownerId)+"&project_id=is.null";
      const rows=await request("assets?select=id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_bucket,object_path,derivative_of,metadata,created_at&"+scope+
        "&metadata->>providerTaskId=eq."+encodeURIComponent(providerTaskId)+
        "&metadata->>outputIndex=eq."+encodeURIComponent(String(outputIndex))+"&deleted_at=is.null&limit=1");
      const row=Array.isArray(rows)?rows[0]:null;
      return row?publicAsset(row):null;
    },
    async reconcilePendingStorageCleanup({limit=20,now=new Date()}={}) {
      limit=Math.max(1,Math.min(100,Number.isInteger(limit)?limit:20));
      const instant=now instanceof Date?now.toISOString():new Date(now).toISOString();
      const rows=await request("asset_storage_cleanup?select=id,storage_bucket,object_path,attempts&completed_at=is.null&next_attempt_at=lte."+encodeURIComponent(instant)+"&order=next_attempt_at.asc&limit="+limit);
      const results=[];
      for(const row of Array.isArray(rows)?rows:[]) {
        if(row.storage_bucket!=="executive-visuals-media"||!validCleanupPath(row.object_path)) {
          results.push({id:row.id,removed:false,permanentError:"unsafe_cleanup_record"});
          continue;
        }
        try {
          await storage.remove(row.object_path);
          const changed=await request("asset_storage_cleanup?id=eq."+encodeURIComponent(row.id)+"&completed_at=is.null",{
            method:"PATCH",prefer:"return=representation",body:{completed_at:instant,last_error:null}
          });
          results.push({id:row.id,removed:Array.isArray(changed)&&changed.length===1});
        } catch(error) {
          const attempts=Math.min(30,Math.max(0,Number(row.attempts)||0)+1);
          const delay=Math.min(86400,30*Math.pow(2,Math.min(attempts-1,11)));
          await request("asset_storage_cleanup?id=eq."+encodeURIComponent(row.id)+"&completed_at=is.null",{
            method:"PATCH",prefer:"return=minimal",body:{attempts,next_attempt_at:new Date(Date.parse(instant)+delay*1000).toISOString(),last_error:String(error?.code||"storage_remove_failed").slice(0,100)}
          });
          results.push({id:row.id,removed:false,retryScheduled:true,attempts});
        }
      }
      return {examined:results.length,removed:results.filter(item=>item.removed).length,results};
    },
    async softDelete({ownerId,assetId}) {
      ownerId=validUuid(ownerId,"owner ID");assetId=validUuid(assetId,"asset ID");
      const rows=await request("assets?select=id,owner_id,project_id,object_path,storage_bucket&id=eq."+encodeURIComponent(assetId)+"&deleted_at=is.null&limit=1");
      const row=Array.isArray(rows)?rows[0]:null;
      if(!row||(!row.project_id&&row.owner_id!==ownerId)) {const error=new Error("Cloud asset not found.");error.code="CLOUD_ASSET_NOT_FOUND";throw error;}
      await allowed(ownerId,row.project_id||null,"write");
      const expectedPrefix=(row.project_id||row.owner_id)+"/"+row.id+"/";
      if(row.storage_bucket!=="executive-visuals-media"||!validCleanupPath(row.object_path)||!row.object_path.startsWith(expectedPrefix)) throw new Error("Cloud asset storage reference is invalid.");
      const changed=await request("assets?id=eq."+encodeURIComponent(assetId)+"&deleted_at=is.null",{method:"PATCH",prefer:"return=representation",body:{deleted_at:new Date().toISOString()}});
      if(!Array.isArray(changed)||changed.length!==1) throw new Error("Cloud asset could not be safely marked deleted.");
      let storageRemoved=false,cleanupRecordFailed=false;
      try { await storage.remove(row.object_path); storageRemoved=true; }
      catch(error) {
        storageRemoved=false;
        try { await enqueueStorageCleanup(row.object_path,error?.code||"asset_soft_delete_storage_cleanup_failed"); }
        catch { cleanupRecordFailed=true; }
      }
      return {id:assetId,deleted:true,storageRemoved,cleanupPending:!storageRemoved,...(cleanupRecordFailed?{cleanupRecordFailed:true}:{})};
    }
  });
}
