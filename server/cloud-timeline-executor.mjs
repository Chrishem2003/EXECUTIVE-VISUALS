import { run, validateMediaOutputProbe } from "./media.mjs";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { verifyRenderManifest } from "./render-manifest.mjs";
import { evaluateDeliveryOutput, getDeliveryProfile } from "./delivery-profiles.mjs";
import { createDeliveryManifest } from "./delivery-manifest.mjs";
import { parseVideoLumaSamples, parseSceneCutTimes, runOptionalSignalCheck } from "./media-signal-analysis.mjs";
import { buildMediaQualityReport } from "./media-quality.mjs";

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
async function analyzeTemporalVideo({path,durationSeconds,jobId,activeProcesses,signal}={}){
  if(signal?.aborted)throw Object.assign(new Error("Timeline render was cancelled."),{code:"JOB_CANCELLED"});
  if(!Number.isFinite(durationSeconds)||durationSeconds<=0)throw Object.assign(new Error("Output duration is unavailable for bounded temporal analysis."),{code:"ANALYSIS_DURATION_UNKNOWN"});
  const coverageSeconds=Math.min(durationSeconds,120);
  const timeoutMs=Math.min(15*60*1000,Math.max(30000,coverageSeconds*2500));
  const result=await run("ffmpeg",["-hide_banner","-nostats","-filter_threads","1","-i",path,"-t",String(coverageSeconds),"-vf","fps=12,scale=320:-2:flags=area,signalstats,scdet=threshold=10,metadata=print","-an","-sn","-dn","-f","null","-"],timeoutMs,jobId,activeProcesses,()=>Boolean(signal?.aborted),512000);
  if(signal?.aborted)throw Object.assign(new Error("Timeline render was cancelled."),{code:"JOB_CANCELLED"});
  const metadataOutput=[result.stderr,result.stdout].join("\n");
  const lumaSamples=parseVideoLumaSamples(metadataOutput);
  if(!lumaSamples.length)throw Object.assign(new Error("FFmpeg did not return usable frame-luminance samples."),{code:"ANALYSIS_NO_FRAME_SAMPLES"});
  return {lumaSamples,sceneChanges:parseSceneCutTimes(metadataOutput),coverageSeconds,truncated:durationSeconds>coverageSeconds};
}

async function cleanupMaterializedAsset(asset){
  try { await asset?.cleanup?.(); } catch {}
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
export function createCloudTimelineExecutor({timelines,mediaIO,renderTimeline,probeOutput=async path=>{const result=await run("ffprobe",["-v","error","-show_format","-show_streams","-of","json",path],60000);return JSON.parse(result.stdout||"{}");},tempRoot,maxAssets=5000,maxOutputBytes=1024*1024*1024,maxInputBytes=2*1024*1024*1024,maxDurationSeconds=4*60*60,analyzeVideo=analyzeTemporalVideo,activeProcesses=new Map()}={}){
  if(!timelines||typeof timelines.get!=="function")throw new Error("Cloud timeline executor requires the cloud timeline repository.");
  if(!mediaIO||typeof mediaIO.materialize!=="function"||typeof mediaIO.publish!=="function")throw new Error("Cloud timeline executor requires cloud media IO.");
  if(typeof renderTimeline!=="function")throw new Error("Cloud timeline executor requires an explicit render engine.");
  if(!Number.isInteger(maxAssets)||maxAssets<1||maxAssets>5000)throw new Error("Cloud timeline asset limit is invalid.");
  if(!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>5*1024*1024*1024)throw new Error("Cloud timeline output limit is invalid.");
  if(!Number.isSafeInteger(maxInputBytes)||maxInputBytes<1||maxInputBytes>20*1024*1024*1024)throw new Error("Cloud timeline input byte limit is invalid.");
  if(!Number.isFinite(maxDurationSeconds)||maxDurationSeconds<=0||maxDurationSeconds>24*60*60)throw new Error("Cloud timeline duration limit is invalid.");

  return async function execute({job,signal,onProgress=()=>{}}={}){
    if(!job||typeof job.id!=="string"||typeof job.owner_id!=="string"||job.job_type!=="timeline.render")throw Object.assign(new Error("Cloud timeline worker received an unsupported job."),{code:"CLOUD_TIMELINE_JOB_UNSUPPORTED"});
    if(signal?.aborted)throw Object.assign(new Error("Timeline render was cancelled."),{code:"JOB_CANCELLED"});
    const input=parseInput(job.input??job.input_json),timelineId=String(input.timelineId||"");
    if(!timelineId)throw Object.assign(new Error("Timeline render requires a timeline ID."),{code:"CLOUD_TIMELINE_NOT_FOUND"});
    const record=await timelines.get({ownerId:job.owner_id,timelineId});
    if(!record)throw Object.assign(new Error("Timeline not found."),{code:"CLOUD_TIMELINE_NOT_FOUND"});
    if(!Number.isInteger(Number(input.timelineRevision))||Number(input.timelineRevision)<1||Number(input.timelineRevision)!==record.revision)throw Object.assign(new Error("Saved timeline revision changed after this render was queued. Submit a new render from the latest revision."),{code:"CLOUD_TIMELINE_REVISION_CHANGED"});
    if((job.project_id||null)!==(record.projectId||null))throw Object.assign(new Error("Timeline does not belong to the claimed job project."),{code:"CLOUD_TIMELINE_PROJECT_MISMATCH"});
    const deliveryProfileId=record.timeline.deliveryProfileId||null;
    if(deliveryProfileId)getDeliveryProfile(deliveryProfileId);
    const assetIds=referencedAssets(record.timeline);
    if(!assetIds.length)throw Object.assign(new Error("Timeline has no enabled source assets."),{code:"CLOUD_TIMELINE_EMPTY"});
    const durationSeconds=Math.max(0,...(record.timeline.tracks||[]).filter(track=>track.enabled!==false).flatMap(track=>(track.clips||[]).filter(clip=>clip.enabled!==false).map(clip=>{
      const start=Number(clip.timelineStart?.value)/Number(clip.timelineStart?.rate),duration=Number(clip.duration?.value)/Number(clip.duration?.rate);
      return Number.isFinite(start)&&Number.isFinite(duration)&&start>=0&&duration>0?start+duration:0;
    })));
    if(!Number.isFinite(durationSeconds)||durationSeconds<=0)throw Object.assign(new Error("Timeline duration is invalid."),{code:"CLOUD_TIMELINE_DURATION_INVALID"});
    if(durationSeconds>maxDurationSeconds)throw Object.assign(new Error("Timeline duration exceeds the configured cloud render limit of "+maxDurationSeconds+" seconds."),{code:"CLOUD_TIMELINE_DURATION_TOO_LARGE"});
    if(assetIds.length>maxAssets)throw Object.assign(new Error("Timeline references too many source assets."),{code:"CLOUD_TIMELINE_TOO_MANY_ASSETS"});
    const workDir=await mkdtemp(join(tempRoot||tmpdir(),"ev-cloud-timeline-")),materialized=new Map();
    let totalInputBytes=0;
    try{
      for(let i=0;i<assetIds.length;i++){
        if(signal?.aborted)throw Object.assign(new Error("Timeline render was cancelled."),{code:"JOB_CANCELLED"});
        const asset=await mediaIO.materialize({ownerId:job.owner_id,assetId:assetIds[i],...(signal?{signal}:{})});
        if(!asset||typeof asset.path!=="string"||!asset.asset||asset.asset.id!==assetIds[i]){await cleanupMaterializedAsset(asset);throw new Error("Cloud timeline source materialization returned invalid asset metadata.");}
        materialized.set(assetIds[i],asset);
        const sourceInfo=await stat(asset.path);
        if(!sourceInfo.isFile()||sourceInfo.size<1)throw Object.assign(new Error("Cloud timeline source materialized as an empty or invalid file."),{code:"CLOUD_TIMELINE_SOURCE_INVALID"});
        totalInputBytes+=sourceInfo.size;
        if(totalInputBytes>maxInputBytes)throw Object.assign(new Error("Timeline source assets exceed the configured cloud render input limit."),{code:"CLOUD_TIMELINE_INPUT_TOO_LARGE"});
        onProgress(Math.min(25,5+Math.round((i+1)/assetIds.length*20)));
      }
      const output=await renderTimeline({timeline:record.timeline,assets:materialized,workDir,signal,onProgress,timelineRevision:record.revision});
      if(!output?.renderManifest||!verifyRenderManifest(output.renderManifest)||output.renderManifest.timelineRevision!==String(record.revision))throw Object.assign(new Error("Timeline renderer did not return a valid manifest for the claimed revision."),{code:"CLOUD_TIMELINE_RENDER_MANIFEST_INVALID"});
      if(signal?.aborted)throw Object.assign(new Error("Timeline render was cancelled."),{code:"JOB_CANCELLED"});
      if(!output||typeof output.path!=="string"||typeof output.filename!=="string"||typeof output.mediaType!=="string")throw new Error("Cloud timeline renderer returned invalid output metadata.");
      const info=await stat(output.path);
      if(!info.isFile()||info.size<1)throw Object.assign(new Error("Timeline renderer produced an empty output."),{code:"CLOUD_TIMELINE_OUTPUT_EMPTY"});
      if(info.size>maxOutputBytes)throw Object.assign(new Error("Timeline output exceeds the configured limit."),{code:"CLOUD_TIMELINE_OUTPUT_TOO_LARGE"});
      const probed=await probeOutput(output.path);
      const probeValidation=validateMediaOutputProbe(probed,output.mediaType);
      const durationSeconds=Number(probed?.format?.duration);
      onProgress(93);
      let temporalCheck;
      try{
        temporalCheck=await runOptionalSignalCheck(async()=>{
          const result=await analyzeVideo({path:output.path,durationSeconds,jobId:job.id,activeProcesses,signal});
          if(!result||!Array.isArray(result.lumaSamples)||result.lumaSamples.length>2000||!Array.isArray(result.sceneChanges)||!Number.isFinite(result.coverageSeconds)||result.coverageSeconds<0||result.coverageSeconds>120||typeof result.truncated!=="boolean")throw Object.assign(new Error("Temporal analyzer returned invalid or unbounded evidence."),{code:"ANALYSIS_RESULT_INVALID"});
          return result;
        },{isCancelled:()=>Boolean(signal?.aborted)});
      }catch(error){
        if(signal?.aborted)throw Object.assign(new Error("Timeline render was cancelled."),{code:"JOB_CANCELLED",cause:error});
        throw error;
      }
      onProgress(97);
      const signalAnalysis={method:"ffmpeg-sampled-frame-luma",performed:[],unavailable:[],lumaSamples:[],sceneChanges:[],coverageSeconds:0,truncated:false};
      if(temporalCheck.status==="completed"){
        signalAnalysis.performed.push("temporal-luma");
        signalAnalysis.lumaSamples=temporalCheck.result.lumaSamples;
        signalAnalysis.sceneChanges=temporalCheck.result.sceneChanges;
        signalAnalysis.coverageSeconds=temporalCheck.result.coverageSeconds;
        signalAnalysis.truncated=temporalCheck.result.truncated;
        if(signalAnalysis.truncated)signalAnalysis.unavailable.push({check:"temporal-luma-coverage",reason:"ANALYSIS_DURATION_LIMIT"});
      }else signalAnalysis.unavailable.push({check:"temporal-luma",reason:temporalCheck.reason});
      const qualityReport=buildMediaQualityReport({...probed,signalAnalysis},{requireVideo:true});
      const deliveryReport=deliveryProfileId?evaluateDeliveryOutput(probed,deliveryProfileId):null;
      if(deliveryReport?.status==="needs-attention")throw Object.assign(new Error("Rendered output failed its selected delivery profile checks; the output was not published."),{code:"DELIVERY_PROFILE_VALIDATION_FAILED",deliveryReport});
      const sha256=await digest(output.path);
      onProgress(90);
      const outputAsset=await mediaIO.publish({
        ownerId:job.owner_id,projectId:record.projectId,filename:output.filename,mediaType:output.mediaType,
        path:output.path,metadata:{...(output.metadata||{}),operation:"timeline.render",timelineId:record.id,timelineRevision:record.revision,renderManifest:output.renderManifest,sha256,probe:probed,probeValidation,signalAnalysis:{...signalAnalysis,lumaSamples:undefined},qualityReport,...(deliveryReport?{deliveryReport}:{}),render:output.render||{}}
      });
      const publishedDeliveryManifest=createDeliveryManifest({timelineId:record.id,timelineRevision:record.revision,outputAsset:outputAsset.id,sha256,byteSize:info.size,mediaType:output.mediaType,profileId:deliveryProfileId,deliveryReport,renderManifest:output.renderManifest});
      // Publish metadata is immutable at this boundary; return the asset-bound manifest as the authoritative receipt.
      onProgress(100);
      return{timelineId:record.id,timelineRevision:record.revision,outputAsset,sha256,byteSize:info.size,probeValidation,qualityReport,...(deliveryReport?{deliveryReport}:{}),deliveryManifest:publishedDeliveryManifest,render:output.render||{},renderManifest:output.renderManifest};
    }finally{
      await Promise.all([...materialized.values()].map(cleanupMaterializedAsset));
      await rm(workDir,{recursive:true,force:true}).catch(()=>{});
    }
  };
}
