import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

/**
 * Cloud-backed media IO for FFmpeg workers. Downloads are materialized into
 * isolated temporary directories and always expose an explicit cleanup hook.
 * Metadata authorization and persistence remain in the asset repository.
 */
export function createCloudMediaAssetIO({assets,fetchImpl=globalThis.fetch,tempRoot=tmpdir(),maxBytes=250*1024*1024,timeoutMs=30000}={}){
 if(!assets||typeof assets.createSignedUrl!=="function"||typeof assets.create!=="function")throw new Error("Cloud media IO requires the cloud asset repository.");
 if(typeof fetchImpl!=="function")throw new Error("Cloud media IO requires fetch.");
 if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>1024*1024*1024)throw new Error("Cloud media IO byte limit is invalid.");
 if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>120000)throw new Error("Cloud media IO timeout is invalid.");

 async function download(url,destination){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  let received=0;const hash=createHash("sha256");
  try{
   const response=await fetchImpl(url,{method:"GET",redirect:"error",signal:controller.signal});
   if(!response.ok)throw Object.assign(new Error("Cloud media download failed."),{code:"CLOUD_MEDIA_DOWNLOAD_FAILED",status:response.status});
   const declared=Number(response.headers?.get?.("content-length")||0);
   if(declared>maxBytes)throw Object.assign(new Error("Cloud media exceeds the worker download limit."),{code:"CLOUD_MEDIA_TOO_LARGE"});
   if(!response.body)throw new Error("Cloud media download returned no body.");
   const meter=new Transform({transform(chunk,encoding,callback){received+=chunk.length;if(received>maxBytes){callback(Object.assign(new Error("Cloud media exceeds the worker download limit."),{code:"CLOUD_MEDIA_TOO_LARGE"}));return;}hash.update(chunk);callback(null,chunk);}});
   await pipeline(response.body,meter,createWriteStream(destination,{flags:"wx"}),{signal:controller.signal});
   if(received<1)throw new Error("Cloud media download was empty.");
   return{size:received,sha256:hash.digest("hex")};
  }catch(error){if(error?.name==="AbortError")throw Object.assign(new Error("Cloud media download timed out."),{code:"CLOUD_MEDIA_TIMEOUT"});throw error;}
  finally{clearTimeout(timer);}
 }

 return Object.freeze({
  async materialize({ownerId,assetId}){
   const signed=await assets.createSignedUrl({ownerId,assetId,expiresIn:300});
   const directory=await mkdtemp(join(tempRoot,"ev-media-"));
   const path=join(directory,"source-"+randomUUID());
   try{
    const downloaded=await download(signed.url,path);
    if(downloaded.size!==Number(signed.asset.size)||downloaded.sha256!==signed.asset.sha256)throw Object.assign(new Error("Cloud media integrity check failed."),{code:"CLOUD_MEDIA_INTEGRITY_MISMATCH"});
    let cleaned=false;
    return{asset:signed.asset,path,size:downloaded.size,sha256:downloaded.sha256,async cleanup(){if(cleaned)return;cleaned=true;await rm(directory,{recursive:true,force:true});}};
   }catch(error){await rm(directory,{recursive:true,force:true}).catch(()=>{});throw error;}
  },
  async publish({ownerId,projectId=null,filename,mediaType,path,derivativeOf=null,metadata={}}){
   const bytes=await readFile(path);
   if(bytes.byteLength>maxBytes)throw Object.assign(new Error("Cloud media output exceeds the worker upload limit."),{code:"CLOUD_MEDIA_TOO_LARGE"});
   return assets.create({ownerId,projectId,originalName:filename,mediaType,bytes,derivativeOf,metadata});
  }
 });
}
