import { randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_ASSET_BYTES=2*1024*1024*1024;

/**
 * Streams a private object response to the authenticated HTTP client and records
 * only bytes that passed through the response pipeline. A signed URL or a
 * declared Content-Length is never treated as transfer evidence.
 *
 * "Delivered" here means accepted by Node's outgoing response stream; HTTP
 * cannot prove that the remote application persisted every byte.
 */
export async function pipeMeasuredPrivateAssetDownload({
  upstream,response,asset,record,transferId=randomUUID(),now=()=>new Date()
}={}){
  if(!upstream||![200,206].includes(upstream.status)||!upstream.body)
    throw Object.assign(new Error("Private storage did not return a usable object response."),{code:"PRIVATE_ASSET_DOWNLOAD_UPSTREAM_INVALID"});
  if(!asset||typeof asset.id!=="string"||!Number.isSafeInteger(Number(asset.size??asset.byte_size))||
    Number(asset.size??asset.byte_size)<1||Number(asset.size??asset.byte_size)>MAX_ASSET_BYTES)
    throw Object.assign(new Error("Private asset download attribution or size is invalid."),{code:"PRIVATE_ASSET_DOWNLOAD_ASSET_INVALID"});
  if(typeof record!=="function")throw new Error("Private asset download requires a durable measurement recorder.");
  if(!/^[0-9a-f-]{36}$/i.test(transferId))throw new Error("Private asset transfer identity is invalid.");

  const assetSize=Number(asset.size??asset.byte_size);
  const headers=upstream.headers;
  const contentType=headers?.get?.("content-type");
  const contentLength=headers?.get?.("content-length");
  const contentRange=headers?.get?.("content-range");
  if(contentType)response.setHeader("content-type",contentType);
  if(contentLength&&/^\d{1,12}$/.test(contentLength)&&Number(contentLength)<=assetSize)response.setHeader("content-length",contentLength);
  if(contentRange&&/^bytes \d+-\d+\/\d+$/.test(contentRange))response.setHeader("content-range",contentRange);
  response.setHeader("accept-ranges","bytes");
  response.statusCode=upstream.status;

  let transferredBytes=0;
  const meter=new Transform({
    transform(chunk,encoding,callback){
      const size=Buffer.isBuffer(chunk)?chunk.length:Buffer.byteLength(chunk,encoding);
      if(size<1){callback();return;}
      if(transferredBytes+size>assetSize){callback(Object.assign(new Error("Private download exceeded the persisted asset size."),{code:"PRIVATE_ASSET_DOWNLOAD_SIZE_MISMATCH"}));return;}
      transferredBytes+=size;
      callback(null,chunk);
    }
  });
  const source=upstream.body instanceof Readable?upstream.body:Readable.fromWeb(upstream.body);
  let streamError=null;
  try{
    await pipeline(source,meter,response);
  }catch(error){
    streamError=error;
    if(!response.headersSent){response.statusCode=502;response.end();}
    else if(!response.destroyed)response.destroy(error);
  }finally{
    if(transferredBytes>0){
      const measuredAt=now().toISOString();
      const measurement={
        measurementId:"asset-egress:"+transferId,
        evidenceMeasurement:"completed_private_asset_http_response",
        resourceType:"egress_gb",unit:"gb",
        quantity:transferredBytes/1_000_000_000,measuredAt,
        dimensions:{assetId:asset.id,transferredBytes,transferId,upstreamStatus:upstream.status,partial:Boolean(streamError)||upstream.status===206}
      };
      await record({asset,measurement});
    }
  }
  return {transferredBytes,transferId,partial:Boolean(streamError)||upstream.status===206,error:streamError};
}
