import { estimateVideoProductionCost } from "./video-cost-estimator.mjs";
import { estimateVideoGenerationCost } from "./video-generation-cost-estimator.mjs";

const MAX_SHOTS=12;
const CLOUD_WORKER_VIDEO_PROVIDERS=new Set(["runway","fal","luma"]);
const text=(value,max)=>typeof value==="string"&&value.trim().length>0&&value.trim().length<=max;
const blocked=(reason,checks=[])=>({status:"blocked",readyForApproval:false,checks,reason});

/**
 * Non-billable production preflight. This function never calls a provider.
 * A shot is ready only when the exact configured model, provider state,
 * duration, framing, resolution, reference inputs and current price are verified.
 */
export function preflightVideoProduction({shots,providerCatalog,pricingCatalog,lumaUsdPerCredit,now}={}){
 if(!Array.isArray(shots)||shots.length<1||shots.length>MAX_SHOTS)
  return blocked("Provide 1–12 planned shots for preflight.");
 const requestedProvider=String(shots[0]?.provider||"");
 const video=providerCatalog?.providers?.find(item=>item.provider===requestedProvider&&item.capabilities?.includes("video.generate"))||
  providerCatalog?.providers?.find(item=>item.id==="video");
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
  if(!CLOUD_WORKER_VIDEO_PROVIDERS.has(provider))fail("worker_adapter","The durable cloud worker has no restart-safe task adapter for this provider yet. Select Runway, Fal or Luma, or wait until this provider's asynchronous submit, poll and reconciliation adapter is verified.");
  else pass("worker_adapter","The durable cloud worker has a restart-safe task adapter for this provider.");
  let modelProfile=null;
  if(video.provider==="runway"||video.provider==="luma")modelProfile=(video.availableModels||[]).find(item=>item.id===model)||null;
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
   maxReferenceImages:modelProfile.maxReferenceImages??video.modelCapabilities?.maxReferenceImages,
   audioModes:Array.isArray(modelProfile.audioModes)?modelProfile.audioModes:(Array.isArray(video.modelCapabilities?.audioModes)?video.modelCapabilities.audioModes:[]),
   durationsSeconds:modelProfile.durationsSeconds||video.modelCapabilities?.durationsSeconds||[],
   operations:modelProfile.operations||video.modelCapabilities?.operations||[]
  }:null;
  const operation=String(shot.operation||"generate");
  if(video.provider==="luma"&&caps&&!caps.operations.includes(operation))fail("operation","Operation is not supported by the selected Ray 3.2 adapter.");
  else if(!["generate","edit","reframe","extend"].includes(operation))fail("operation","Select a supported generation, edit, reframe or extend operation.");
  else pass("operation","Selected operation is supported by the provider adapter.");
  if(video.provider==="luma"&&(operation==="edit"||operation==="reframe")&&
     !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(shot.sourceVideoAssetId||"")))
   fail("source_video","Video editing and reframing require an authorized private source-video asset.");
  else if(video.provider==="luma"&&operation==="extend"&&
     !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(shot.sourceGenerationId||"")))
   fail("source_video","Video extension requires a valid prior Luma generation ID owned by the same caller.");
  else pass("source_video","Source-video requirements are satisfied for the selected operation.");
  if(!Number.isInteger(shot.durationSeconds)||shot.durationSeconds<1||shot.durationSeconds>300)fail("duration","Duration must be a whole number between 1 and 300 seconds.");
  else if(video.provider==="luma"&&operation==="reframe"&&(shot.durationSeconds<1||shot.durationSeconds>300))fail("duration","Reframe source duration must be 1–300 seconds.");
  else if(video.provider==="luma"&&caps&&!caps.durationsSeconds.includes(shot.durationSeconds))fail("duration","Ray 3.2 generation, editing and extension support only 5- or 10-second outputs.");
  else if(video.provider!=="luma"&&shot.durationSeconds>30)fail("duration","Shot duration exceeds the selected model's 30-second preflight limit.");
  else if(video.provider!=="luma"&&caps&&(!Number.isFinite(caps.minDurationSeconds)||!Number.isFinite(caps.maxDurationSeconds)||shot.durationSeconds<caps.minDurationSeconds||shot.durationSeconds>caps.maxDurationSeconds))fail("duration","Duration is outside the selected model's documented range.");
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
  else if(caps&&Number.isInteger(caps.maxReferenceImages)&&referenceImageCount>caps.maxReferenceImages)fail("references","Reference image count exceeds the selected model's maximum.");
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
 let quote;
 if(video.provider==="luma"){
  const rateText=String(lumaUsdPerCredit??"").trim();
  const rateValid=/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(rateText)&&Number(rateText)>0&&Number(rateText)<=1000;
  if(!rateValid)return {
   status:"pricing_unverified",readyForApproval:false,shotCount:shots.length,shots:results,
   pricing:{status:"unavailable",reason:"A positive LUMA_USD_PER_CREDIT account/contract rate is required."},
   requestsSubmitted:false,
   reason:"Technical checks passed, but the Luma account/contract credit rate is unavailable. No generation jobs were submitted."
  };
  const clock=typeof now==="function"?now():now;
  const observed=new Date(clock??Date.now());
  if(!Number.isFinite(observed.getTime()))return blocked("The pricing clock is invalid.");
  const observedAt=observed.toISOString(),expiresAt=new Date(observed.getTime()+24*60*60*1000).toISOString();
  const priced=[];
  try{
   for(const shot of shots){
    const lumaOperation={generate:"video",edit:"video_edit",reframe:"video_reframe",extend:"video_extend"}[shot.operation||"generate"];
    const estimate=estimateVideoGenerationCost({
     provider:"luma",model:shot.model,operation:lumaOperation,
     durationSeconds:shot.durationSeconds,resolution:shot.resolution||"720p",
     hdr:shot.hdr===true,exrExport:shot.exrExport===true
    });
    const amount=Number((estimate.credits*Number(rateText)).toFixed(6));
    if(!Number.isFinite(amount)||amount<0)throw new Error("Luma estimate is invalid.");
    priced.push({
     shotId:shot.id,durationSeconds:shot.durationSeconds,provider:"luma",model:shot.model,
     currency:"USD",amount,breakdown:{video:amount,audio:0,references:0,minimumApplied:0},
     pricing:{sourceUrl:estimate.pricingSource,observedAt,expiresAt,pricingDate:estimate.pricingDate,
      credits:estimate.credits,usdPerCredit:rateText,formula:estimate.pricingFormula,
      status:estimate.pricingStatus,scope:estimate.monetaryEstimateScope}
    });
   }
  }catch(error){
   return {status:"pricing_unverified",readyForApproval:false,shotCount:shots.length,shots:results,
    pricing:{status:"unavailable",reason:String(error?.message||"Luma pricing is unavailable.")},
    requestsSubmitted:false,reason:"Technical checks passed, but this exact Luma operation, duration and resolution has no verified price."};
  }
  const amount=Number(priced.reduce((sum,item)=>sum+item.amount,0).toFixed(6));
  const totalDurationSeconds=shots.reduce((sum,shot)=>sum+shot.durationSeconds,0);
  quote={available:true,estimated:true,shotCount:shots.length,totalDurationSeconds,currency:"USD",amount,
   breakdown:{video:amount,audio:0,references:0,minimumApplied:0},shots:priced,
   disclaimer:"Estimate uses published Luma credit requirements multiplied by the configured account/contract USD-per-credit rate. Provider pricing can change; quote expires after 24 hours. No generation jobs were submitted."};
 }else{
  quote=estimateVideoProductionCost({shots:shots.map(shot=>({
   id:shot.id,provider:shot.provider,model:shot.model,durationSeconds:shot.durationSeconds,
   resolution:shot.resolution||"provider_default",audioMode:shot.audioMode||"none",
   referenceImageCount:shot.referenceImageCount||0
  }))},pricingCatalog,{now});
 }
 if(!quote.available)return {
  status:"pricing_unverified",readyForApproval:false,shotCount:shots.length,shots:results,
  pricing:{status:"unavailable",reason:quote.reason},
  requestsSubmitted:false,
  reason:"Technical checks passed, but current source-attributed pricing is unavailable. No estimated price will be invented; obtain a current rate card before budget approval."
 };
 return {
  status:"ready_for_approval",readyForApproval:true,shotCount:shots.length,shots:results,
  pricing:{status:"verified_estimate",quote},
  requestsSubmitted:false,
  reason:"Technical compatibility and current source-attributed pricing passed. This is a dry-run only; a separate explicit budget approval and submission action are still required."
 };
}
