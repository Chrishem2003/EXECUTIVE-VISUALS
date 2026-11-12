import { run, validateMediaOutputProbe } from "./media.mjs";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createC2paTransformationPreserver } from "./c2pa-transformation-preserver.mjs";

const defaultC2paPreserver=createC2paTransformationPreserver();

function parseInput(value){
  if(value&&typeof value==="object"&&!Array.isArray(value))return value;
  try{const parsed=JSON.parse(String(value||"{}"));if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))return parsed;}catch{}
  throw Object.assign(new Error("Cloud timeline job input is invalid."),{code:"INVALID_JOB_INPUT"});
}
async function digest(path){
  const hash=createHash("sha256");
  await pipeline(createReadStream(path),new Transform({transform(chunk,encoding,callback){hash.update(chunk);callback(null,chunk);}}),new Transform({transform(chunk,encoding,callback){callback();}}));
  return hash.digest("hex");
}
function referencedAssets(timeline){
  const ids=new Set();
  for(const track of timeline.tracks||[])if(track.enabled!==false)for(const clip of track.clips||[])if(clip.enabled!==false&&clip.assetId)ids.add(clip.assetId);
  return [...ids];
}

/**
 * Timeline execution boundary. The cloud renderer is injected by the worker
 * assembly and receives only verified materialized asset paths; the local
 * SQLite renderer is never passed cloud records or storage references.
 */
export function createCloudTimelineExecutor({timelines,mediaIO,renderTimeline,probeOutput=async path=>{const result=await run("ffprobe",["-v","error","-show_format","-show_streams","-of","json",path],60000);return JSON.parse(result.stdout||"{}");},tempRoot,maxAssets=5000,maxOutputBytes=1024*1024*1024,c2paPreserver=defaultC2paPreserver,c2paSigner=null,c2paSignerMode="local"}={}){
  if(!timelines||typeof timelines.get!=="function")throw new Error("Cloud timeline executor requires the cloud timeline repository.");
  if(!mediaIO||typeof mediaIO.materialize!=="function"||typeof mediaIO.publish!=="function")throw new Error("Cloud timeline executor requires cloud media IO.");
  if(typeof renderTimeline!=="function")throw new Error("Cloud timeline executor requires an explicit render engine.");
  if(!Number.isInteger(maxAssets)||maxAssets<1||maxAssets>5000)throw new Error("Cloud timeline asset limit is invalid.");
  if(!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>5*1024*1024*1024)throw new Error("Cloud timeline output limit is invalid.");

  return async function execute({job,signal,onProgress=()=>{},assertLease=async()=>true}={}){
    if(!job||typeof job.id!=="string"||typeof job.owner_id!=="string"||job.job_type!=="timeline.render")throw Object.assign(new Error("Cloud timeline worker received an unsupported job."),{code:"CLOUD_TIMELINE_JOB_UNSUPPORTED"});
    if(signal?.aborted)throw Object.assign(new Error("Timeline render was cancelled."),{code:"JOB_CANCELLED"});
    const input=parseInput(job.input??job.input_json),timelineId=String(input.timelineId||"");
    if(!timelineId)throw Object.assign(new Error("Timeline render requires a timeline ID."),{code:"CLOUD_TIMELINE_NOT_FOUND"});
    const record=await timelines.get({ownerId:job.owner_id,timelineId});
    if(!record)throw Object.assign(new Error("Timeline not found."),{code:"CLOUD_TIMELINE_NOT_FOUND"});
    if(!Number.isInteger(Number(input.timelineRevision))||Number(input.timelineRevision)<1||Number(input.timelineRevision)!==record.revision)throw Object.assign(new Error("Saved timeline revision changed after this render was queued. Submit a new render from the latest revision."),{code:"CLOUD_TIMELINE_REVISION_CHANGED"});
    if((job.project_id||null)!==(record.projectId||null))throw Object.assign(new Error("Timeline does not belong to the claimed job project."),{code:"CLOUD_TIMELINE_PROJECT_MISMATCH"});
    const assetIds=referencedAssets(record.timeline);
    if(!assetIds.length)throw Object.assign(new Error("Timeline has no enabled source assets."),{code:"CLOUD_TIMELINE_EMPTY"});
    if(assetIds.length>maxAssets)throw Object.assign(new Error("Timeline references too many source assets."),{code:"CLOUD_TIMELINE_TOO_MANY_ASSETS"});
    const workDir=await mkdtemp(join(tempRoot||tmpdir(),"ev-cloud-timeline-")),materialized=new Map();
    try{
      for(let i=0;i<assetIds.length;i++){
        if(signal?.aborted)throw Object.assign(new Error("Timeline render was cancelled."),{code:"JOB_CANCELLED"});
        const asset=await mediaIO.materialize({ownerId:job.owner_id,assetId:assetIds[i]});
        if(!asset||typeof asset.path!=="string"||!asset.asset||asset.asset.id!==assetIds[i]){await asset?.cleanup?.().catch(()=>{});throw new Error("Cloud timeline source materialization returned invalid asset metadata.");}
        materialized.set(assetIds[i],asset);
        onProgress(Math.min(25,5+Math.round((i+1)/assetIds.length*20)));
      }
      const output=await renderTimeline({timeline:record.timeline,assets:materialized,workDir,signal,onProgress});
      if(signal?.aborted)throw Object.assign(new Error("Timeline render was cancelled."),{code:"JOB_CANCELLED"});
      if(!output||typeof output.path!=="string"||typeof output.filename!=="string"||typeof output.mediaType!=="string")throw new Error("Cloud timeline renderer returned invalid output metadata.");
      const initialInfo=await stat(output.path);
      if(!initialInfo.isFile()||initialInfo.size<1)throw Object.assign(new Error("Timeline renderer produced an empty output."),{code:"CLOUD_TIMELINE_OUTPUT_EMPTY"});
      if(initialInfo.size>maxOutputBytes)throw Object.assign(new Error("Timeline output exceeds the configured limit."),{code:"CLOUD_TIMELINE_OUTPUT_TOO_LARGE"});
      await assertLease();
      const sourceAssets=[...materialized.values()].map(item=>({path:item.path,mediaType:item.asset.mediaType||item.asset.media_type,sha256:item.asset.sha256})).filter(item=>/^(image|video|audio)\//.test(String(item.mediaType||"")));
      const c2paPreservation=sourceAssets.length?await c2paPreserver({sources:sourceAssets,outputPath:output.path,outputMimeType:output.mediaType,signer:c2paSigner,signerMode:c2paSignerMode,operation:"timeline.render",signal}):{status:"not_checked",preserved:false,reason:"NO_SUPPORTED_MEDIA_SOURCES"};
      const info=await stat(output.path);
      if(!info.isFile()||info.size<1||info.size>maxOutputBytes)throw Object.assign(new Error("Signed timeline output is empty or exceeds the configured limit."),{code:"CLOUD_TIMELINE_OUTPUT_INVALID"});
      const probed=await probeOutput(output.path);
      const probeValidation=validateMediaOutputProbe(probed,output.mediaType);
      const sha256=await digest(output.path);
      onProgress(90);
      if(signal?.aborted)throw Object.assign(new Error("Timeline render was cancelled."),{code:"JOB_CANCELLED"});
      const outputAsset=await mediaIO.publish({
        ownerId:job.owner_id,projectId:record.projectId,filename:output.filename,mediaType:output.mediaType,
        path:output.path,publicationKey:job.id+":output:v1",signal,assertLease,leaseContext:{jobId:job.id,workerId:job.lease_owner,leaseToken:job.lease_token},metadata:{...(output.metadata||{}),operation:"timeline.render",timelineId:record.id,timelineRevision:record.revision,sha256,probe:probed,probeValidation,c2paPreservation,render:output.render||{}}
      });
      onProgress(100);
      return{timelineId:record.id,timelineRevision:record.revision,outputAsset,sha256,byteSize:info.size,probeValidation,c2paPreservation,render:output.render||{}};
    }finally{
      await Promise.all([...materialized.values()].map(asset=>asset.cleanup?.().catch(()=>{})));
      await rm(workDir,{recursive:true,force:true}).catch(()=>{});
    }
  };
}
