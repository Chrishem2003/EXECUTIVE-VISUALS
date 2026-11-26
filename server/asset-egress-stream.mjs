import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

const MAX_ASSET_BYTES=2*1024*1024*1024;

/**
 * Streams a private object response to the authenticated HTTP client and records
 * only chunks whose outgoing response write callback completed successfully.
 * A signed URL or declared Content-Length is never transfer evidence.
 *
 * This measures bytes accepted by Node's outgoing response stream; HTTP cannot
 * prove that the remote application persisted every byte.
 */
export async function pipeMeasuredPrivateAssetDownload({
  upstream,response,asset,record,transferId=randomUUID(),now=()=>new Date()
}={}){
  if(!upstream||![200,206].includes(upstream.status)||!upstream.body)
    throw Object.assign(new Error("Private storage did not return a usable object response."),{code:"PRIVATE_ASSET_DOWNLOAD_UPSTREAM_INVALID"});
  const assetSize=Number(asset?.size??asset?.byte_size);
  if(!asset||typeof asset.id!=="string"||!Number.isSafeInteger(assetSize)||assetSize<1||assetSize>MAX_ASSET_BYTES)
    throw Object.assign(new Error("Private asset download attribution or size is invalid."),{code:"PRIVATE_ASSET_DOWNLOAD_ASSET_INVALID"});
  if(typeof record!=="function")throw new Error("Private asset download requires a durable measurement recorder.");
  if(!/^[0-9a-f-]{36}$/i.test(transferId))throw new Error("Private asset transfer identity is invalid.");

  const headers=upstream.headers,contentType=headers?.get?.("content-type"),contentLength=headers?.get?.("content-length"),contentRange=headers?.get?.("content-range");
  if(contentType)response.setHeader("content-type",contentType);
  if(contentLength&&/^\d{1,12}$/.test(contentLength)&&Number(contentLength)<=assetSize)response.setHeader("content-length",contentLength);
  if(contentRange&&/^bytes \d+-\d+\/\d+$/.test(contentRange))response.setHeader("content-range",contentRange);
  response.setHeader("accept-ranges","bytes");response.statusCode=upstream.status;

  const source=upstream.body instanceof Readable?upstream.body:Readable.fromWeb(upstream.body);
  let transferredBytes=0,streamError=null;
  try{
    for await(const chunkValue of source){
      const chunk=Buffer.isBuffer(chunkValue)?chunkValue:Buffer.from(chunkValue);
      if(transferredBytes+chunk.length>assetSize)
        throw Object.assign(new Error("Private download exceeded the persisted asset size."),{code:"PRIVATE_ASSET_DOWNLOAD_SIZE_MISMATCH"});
      await new Promise((resolve,reject)=>{
        let settled=false;
        const cleanup=()=>{if(typeof response.off==="function")response.off("error",onError);};
        const finish=(error)=>{if(settled)return;settled=true;if(!error)cleanup();error?reject(error):resolve();};
        const onError=error=>{cleanup();finish(error);};
        if(typeof response.once==="function")response.once("error",onError);
        try{response.write(chunk,error=>finish(error));}
        catch(error){cleanup();finish(error);}
      });
      transferredBytes+=chunk.length;
    }
    await new Promise((resolve,reject)=>{
      let settled=false;
      const cleanup=()=>{if(typeof response.off==="function")response.off("error",onError);};
      const finish=(error)=>{if(settled)return;settled=true;if(!error)cleanup();error?reject(error):resolve();};
      const onError=error=>{cleanup();finish(error);};
      if(typeof response.once==="function")response.once("error",onError);
      try{response.end(error=>finish(error));}
      catch(error){cleanup();finish(error);}
    });
  }catch(error){
    streamError=error;
    source.destroy?.();
    if(response.headersSent&&!response.destroyed)response.destroy();
    else if(!response.destroyed){response.statusCode=502;response.end();}
  }finally{
    if(transferredBytes>0){
      const measuredAt=now().toISOString();
      const measurement={
        measurementId:"asset-egress:"+transferId,
        evidenceMeasurement:"completed_private_asset_http_response",
        resourceType:"egress_gb",unit:"gb",quantity:transferredBytes/1_000_000_000,measuredAt,
        dimensions:{assetId:asset.id,transferredBytes,transferId,upstreamStatus:upstream.status,partial:Boolean(streamError)||upstream.status===206}
      };
      await record({asset,measurement});
    }
  }
  return{transferredBytes,transferId,partial:Boolean(streamError)||upstream.status===206,error:streamError};
}
