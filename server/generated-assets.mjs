import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join, relative, sep, resolve } from "node:path";
import { json } from "./db.mjs";

function imageType(buffer){
 if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mimeType:"image/png",extension:"png"};
 if(buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return {mimeType:"image/jpeg",extension:"jpg"};
 if(buffer.length>=12&&buffer.toString("ascii",0,4)==="RIFF"&&buffer.toString("ascii",8,12)==="WEBP")return {mimeType:"image/webp",extension:"webp"};
 throw Object.assign(new Error("Generated image has an unsupported or invalid file signature."),{code:"IMAGE_SIGNATURE_INVALID"});
}
const safeSegment=value=>String(value||"").replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,80)||"unknown";
export async function storeGeneratedImage({db,mediaRoot,ownerId,projectId=null,jobId,prompt,model,buffer}){
 const type=imageType(buffer);
 const id=randomUUID(),directory=join(mediaRoot,safeSegment(ownerId),safeSegment(projectId||"personal"));
 const absolute=resolve(directory,id+"."+type.extension);
 const root=resolve(mediaRoot),storagePath=relative(root,absolute).split(sep).join("/");
 if(storagePath.startsWith("..")||resolve(root,storagePath)!==absolute)throw Object.assign(new Error("Generated asset path failed validation."),{code:"ASSET_PATH_INVALID"});
 await mkdir(directory,{recursive:true});
 try{
  await writeFile(absolute,buffer,{flag:"wx"});
  const sha256=createHash("sha256").update(buffer).digest("hex");
  const promptHash=createHash("sha256").update(String(prompt||"")).digest("hex");
  const name="generated-"+id+"."+type.extension;
  const metadata={generated:true,model,promptHash,jobId,createdAt:new Date().toISOString()};
  db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id,ownerId,projectId,name,type.mimeType,buffer.length,sha256,storagePath,json(metadata));
  return {id,projectId,name,mediaType:type.mimeType,size:buffer.length,sha256,storagePath,metadata};
 }catch(error){await unlink(absolute).catch(()=>{});throw error;}
}

export async function storeGeneratedVideo({db,mediaRoot,ownerId,projectId=null,jobId,prompt,model,provenance=null,cloudWorkspaceAssetId=null,cloudVideoJobId=null,cloudSha256=null,buffer}){
 if(!Buffer.isBuffer(buffer)||buffer.length<12||buffer.toString("ascii",4,8)!=="ftyp"||buffer.length>250*1024*1024)throw Object.assign(new Error("Generated video has an unsupported signature or exceeds the 250 MiB limit."),{code:"VIDEO_SIGNATURE_INVALID"});
 const hasCloudReceipt=cloudWorkspaceAssetId!==null||cloudVideoJobId!==null||cloudSha256!==null;
 if(hasCloudReceipt&&(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(cloudWorkspaceAssetId||""))||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(cloudVideoJobId||""))||! /^[a-f0-9]{64}$/i.test(String(cloudSha256||""))))throw Object.assign(new Error("Cloud video asset lineage receipt is invalid."),{code:"VIDEO_CLOUD_ASSET_RECEIPT_INVALID"});
 const id=randomUUID(),directory=join(mediaRoot,safeSegment(ownerId),safeSegment(projectId||"personal"));
 const absolute=resolve(directory,id+".mp4"),root=resolve(mediaRoot),storagePath=relative(root,absolute).split(sep).join("/");
 if(storagePath.startsWith("..")||resolve(root,storagePath)!==absolute)throw Object.assign(new Error("Generated video path failed validation."),{code:"ASSET_PATH_INVALID"});
 await mkdir(directory,{recursive:true});
 try{
  await writeFile(absolute,buffer,{flag:"wx"});
  const sha256=createHash("sha256").update(buffer).digest("hex"),promptHash=createHash("sha256").update(String(prompt||"")).digest("hex");
  const name="generated-"+id+".mp4",metadata={generated:true,model,promptHash,jobId,createdAt:new Date().toISOString(),...(provenance?{generationProvenance:provenance}:{}),...(hasCloudReceipt?{cloudWorkspaceAssetId,cloudVideoJobId,cloudSha256}:{})};
  db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)").run(id,ownerId,projectId,name,"video/mp4",buffer.length,sha256,storagePath,json(metadata));
  return {id,projectId,name,mediaType:"video/mp4",size:buffer.length,sha256,storagePath,metadata};
 }catch(error){await unlink(absolute).catch(()=>{});throw error;}
}

export async function storeGeneratedAudio({db,mediaRoot,ownerId,projectId=null,jobId,prompt,model,buffer,mimeType="audio/mpeg"}){
 const types={"audio/mpeg":"mp3","audio/wav":"wav","audio/flac":"flac","audio/ogg":"ogg"};
 const extension=types[mimeType];
 if(!extension||!Buffer.isBuffer(buffer)||buffer.length<4||buffer.length>50*1024*1024)throw Object.assign(new Error("Generated audio has an unsupported format or exceeds the 50 MiB limit."),{code:"AUDIO_SIGNATURE_INVALID"});
 const signature=extension==="mp3"?(buffer.subarray(0,3).toString("ascii")==="ID3"||buffer[0]===0xff&&(buffer[1]&0xe0)===0xe0):extension==="wav"?(buffer.length>=12&&buffer.toString("ascii",0,4)==="RIFF"&&buffer.toString("ascii",8,12)==="WAVE"):extension==="flac"?buffer.toString("ascii",0,4)==="fLaC":buffer.toString("ascii",0,4)==="OggS";
 if(!signature)throw Object.assign(new Error("Generated audio failed binary signature validation."),{code:"AUDIO_SIGNATURE_INVALID"});
 const id=randomUUID(),directory=join(mediaRoot,safeSegment(ownerId),safeSegment(projectId||"personal"));
 const absolute=resolve(directory,id+"."+extension),root=resolve(mediaRoot),storagePath=relative(root,absolute).split(sep).join("/");
 if(storagePath.startsWith("..")||resolve(root,storagePath)!==absolute)throw Object.assign(new Error("Generated audio path failed validation."),{code:"ASSET_PATH_INVALID"});
 await mkdir(directory,{recursive:true});
 try{
  await writeFile(absolute,buffer,{flag:"wx"});
  const sha256=createHash("sha256").update(buffer).digest("hex"),promptHash=createHash("sha256").update(String(prompt||"")).digest("hex");
  const name="generated-"+id+"."+extension,metadata={generated:true,model,promptHash,jobId,createdAt:new Date().toISOString()};
  db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)")
   .run(id,ownerId,projectId,name,mimeType,buffer.length,sha256,storagePath,json(metadata));
  return {id,projectId,name,mediaType:mimeType,size:buffer.length,sha256,storagePath,metadata};
 }catch(error){await unlink(absolute).catch(()=>{});throw error;}
}
