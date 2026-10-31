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
