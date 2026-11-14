import { estimateVideoProductionCost } from "./video-cost-estimator.mjs";

const MAX_SHOTS=12;
const CLOUD_WORKER_VIDEO_PROVIDERS=new Set(["runway","fal"]);
const text=(value,max)=>typeof value==="string"&&value.trim().length>0&&value.trim().length<=max;
const blocked=(reason,checks=[])=>({status:"blocked",readyForApproval:false,checks,reason});

/**
 * Non-billable production preflight. This function never calls a provider.
 * A shot is ready only when the exact configured model, provider state,
 * duration, framing, resolution, reference inputs and current price are verified.
 */
export function preflightVideoProduction({shots,providerCatalog,pricingCatalog,now}={}){
 if(!Array.isArray(shots)||shots.length<1||shots.length>MAX_SHOTS)
  return blocked("Provide 1–12 planned shots for preflight.");
 const video=providerCatalog?.providers?.find(item=>item.id==="video");
 if(!video)return blocked("The video provider catalog is unavailable.");
 const results=shots.map((shot,index)=>{
  const checks=[];
  const fail=(id,reason)=>checks.push({id,status:"failed",reason});
  const pass=(id,reason)=>checks.push({id,status:"passed",reason});
  if(!shot||typeof shot!=="object"||Array.isArray(shot))return {shotId:"shot-"+(index+1),...blocked("Shot data is invalid.")};
  const id=text(shot.id,120)?shot.id.trim():"shot-"+(index+1);
  if(!text(shot.prompt,12000))fail("prompt","A non-empty prompt of at most 12,000 characters is required.");
  else pass("prompt","Prompt is present.");
  if(shot.rightsConfirmed!==true)fail("rights","Explicit rights clearance is required for the prompts, references and any likeness or voice use.");
  else pass("rights","The requester explicitly confirmed rights clearance.");
  if(video.status!=="ready")fail("provider",video.reason||"Video provider is not configured and opted in.");
  else pass("provider","Server-side provider is configured and remote opt-in is enabled.");
  const provider=String(shot.provider||"");
  const model=String(shot.model||"");
  if(provider!==video.provider)fail("provider_match","Shot provider does not match the configured video provider.");
  else pass("provider_match","Shot provider matches the configured provider.");
  if(!CLOUD_WORKER_VIDEO_PROVIDERS.has(provider))fail("worker_adapter","The durable cloud worker has no restart-safe task adapter for this provider yet. Select Runway or Fal, or wait until this provider's asynchronous submit, poll and reconciliation adapter is verified.");
  else pass("worker_adapter","The durable cloud worker has a restart-safe task adapter for this provider.");
  let modelProfile=null;
  if(video.provider==="runway")modelProfile=(video.availableModels||[]).find(item=>item.id===model)||null;
  else if(video.provider==="fal"&&model===video.model)modelProfile={
   id:model,minDurationSeconds:video.modelCapabilities?.minDurationSeconds,
   maxDurationSeconds:video.modelCapabilities?.maxDurationSeconds,
   aspectRatios:video.modelCapabilities?.aspectRatios,
   resolutions:video.modelCapabilities?.resolutions,
   referenceImages:video.modelCapabilities?.referenceImages
  };
  if(!modelProfile)fail("model","The exact requested model is not in the configured provider's supported model catalog.");
  else pass("model","Exact model is present in the provider catalog.");
  const caps=modelProfile?{
   minDurationSeconds:modelProfile.minDurationSeconds,
   maxDurationSeconds:modelProfile.maxDurationSeconds,
   aspectRatios:modelProfile.aspectRatios||[],
   resolutions:modelProfile.resolutions||[],
   referenceImages:modelProfile.constraints?.multipleReferenceImages??modelProfile.referenceImages??false,
   audioModes:Array.isArray(modelProfile.audioModes)?modelProfile.audioModes:(Array.isArray(video.modelCapabilities?.audioModes)?video.modelCapabilities.audioModes:[])
  }:null;
  if(!Number.isInteger(shot.durationSeconds)||shot.durationSeconds<1||shot.durationSeconds>30)fail("duration","Shot duration must be 1–30 whole seconds.");
  else if(caps&&(!Number.isFinite(caps.minDurationSeconds)||!Number.isFinite(caps.maxDurationSeconds)||shot.durationSeconds<caps.minDurationSeconds||shot.durationSeconds>caps.maxDurationSeconds))fail("duration","Duration is outside the selected model's documented range.");
  else pass("duration","Duration is within the model's supported range.");
  const ratio=String(shot.aspectRatio||"");
  if(!ratio)fail("aspect_ratio","Select an explicit aspect ratio.");
  else if(caps&&!caps.aspectRatios.includes(ratio))fail("aspect_ratio","Aspect ratio is not supported by the selected model.");
  else pass("aspect_ratio","Aspect ratio is supported.");
  const resolution=String(shot.resolution||"provider_default");
  if(caps&&!caps.resolutions.includes(resolution))fail("resolution","Resolution is not supported by the selected model.");
  else pass("resolution","Resolution is supported.");
  const referenceImageCount=shot.referenceImageCount??0;
  if(!Number.isInteger(referenceImageCount)||referenceImageCount<0||referenceImageCount>12)fail("references","Reference image count must be 0–12.");
  else if(referenceImageCount>0&&caps&&!caps.referenceImages)fail("references","Selected model does not support reference images.");
  else pass("references","Reference image requirements are compatible.");
  const audioMode=String(shot.audioMode||"provider_default");
  const supportedAudioModes=new Set((caps?.audioModes||[]).map(value=>String(value).toLowerCase()));
  if(!["provider_default","generated","none","reference"].includes(audioMode))fail("audio_mode","Select a supported audio mode.");
  else if(audioMode==="generated"&&!supportedAudioModes.has("generated")&&!supportedAudioModes.has("generate"))fail("audio_mode","Selected model does not advertise generated-audio support.");
  else if(audioMode==="reference"&&!supportedAudioModes.has("reference"))fail("audio_mode","Selected model does not advertise reference-audio support.");
  else pass("audio_mode",audioMode==="provider_default"?"Provider-default audio behavior selected.":audioMode==="none"?"Audio generation is disabled.":"Selected audio mode is advertised by the model.");
  const failed=checks.filter(item=>item.status==="failed");
  return {shotId:id,status:failed.length?"blocked":"technically_ready",readyForApproval:failed.length===0,checks,reason:failed.map(item=>item.reason).join(" ")||"Technical checks passed; current pricing and budget approval remain required."};
 });
 const blockedShots=results.filter(item=>!item.readyForApproval);
 if(blockedShots.length)return {
  status:"blocked",readyForApproval:false,shotCount:shots.length,shots:results,
  pricing:{status:"not_evaluated"},
  requestsSubmitted:false,
  reason:blockedShots.length+" shot(s) failed technical preflight. Correct the listed issues before requesting approval."
 };
 const quote=estimateVideoProductionCost({shots:shots.map(shot=>({
  id:shot.id,provider:shot.provider,model:shot.model,durationSeconds:shot.durationSeconds,
  resolution:shot.resolution||"provider_default",audioMode:shot.audioMode||"none",
  referenceImageCount:shot.referenceImageCount||0
 }))},pricingCatalog,{now});
 if(!quote.available)return {
  status:"pricing_unverified",readyForApproval:false,shotCount:shots.length,shots:results,
  pricing:{status:"unavailable",reason:quote.reason},
  requestsSubmitted:false,
  reason:"Technical checks passed, but verified current pricing is unavailable. No estimated price will be invented; obtain a current rate card before budget approval."
 };
 return {
  status:"ready_for_approval",readyForApproval:true,shotCount:shots.length,shots:results,
  pricing:{status:"verified_estimate",quote},
  requestsSubmitted:false,
  reason:"Technical compatibility and current source-attributed pricing passed. This is a dry-run only; a separate explicit budget approval and submission action are still required."
 };
}
