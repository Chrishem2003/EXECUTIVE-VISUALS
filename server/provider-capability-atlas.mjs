import { listRunwayVideoModels, getRunwayVideoCapabilities } from "./runway-video-gateway.mjs";

const RUNWAY_DOCS="https://docs.dev.runwayml.com/api/";
const RUNWAY_OPERATIONS=Object.freeze([
 {id:"video.generate",label:"Text-to-video generation",status:"implemented",endpoint:"POST /v1/text_to_video",billingRisk:"billable",inputRoles:["prompt"],notes:"Async task submission and bounded MP4 ingestion are implemented for the allowlisted model profiles."},
 {id:"video.image_to_video",label:"Image-to-video generation",status:"implemented",endpoint:"POST /v1/image_to_video",billingRisk:"billable",inputRoles:["prompt","first_frame"],notes:"One validated first-frame image is supported; intermediate and end keyframes are not."},
 {id:"video.video_to_video",label:"Video-to-video editing",status:"documented_not_integrated",endpoint:"POST /v1/video_to_video",billingRisk:"billable",inputRoles:["source_video","edit_prompt","reference_video"],notes:"Requires a separate source-video upload, model-specific constraints, output lineage and durable worker integration."},
 {id:"video.upscale",label:"Video upscaling",status:"documented_not_integrated",endpoint:"Provider-specific video upscale operation",billingRisk:"billable",inputRoles:["source_video"],notes:"Must create a derivative and validate actual dimensions, codec and duration."},
 {id:"video.frame_interpolation",label:"Frame-rate enhancement",status:"documented_not_integrated",endpoint:"Provider-specific frame interpolation operation",billingRisk:"billable",inputRoles:["source_video","target_frame_rate"],notes:"Requires frame-rate and duration validation after processing."},
 {id:"video.hdr_conversion",label:"Video-to-HDR conversion",status:"documented_not_integrated",endpoint:"Provider-specific HDR conversion operation",billingRisk:"billable",inputRoles:["source_video","target_color_space"],notes:"Requires color metadata validation and preservation of the original source."},
 {id:"audio.generate_from_video",label:"Synchronized audio generation",status:"documented_not_integrated",endpoint:"Provider-specific video-to-audio operation",billingRisk:"billable",inputRoles:["source_video","audio_prompt"],notes:"Audio should be stored as a separate derivative and checked for duration alignment."},
 {id:"speech.text_to_speech",label:"Text-to-speech",status:"documented_not_integrated",endpoint:"Provider-specific speech operation",billingRisk:"billable",inputRoles:["text","voice"],notes:"Voice permissions and consent scope must be recorded before execution."},
 {id:"speech.dubbing",label:"Speech dubbing and localization",status:"documented_not_integrated",endpoint:"Provider-specific dubbing operation",billingRisk:"billable",inputRoles:["source_video","transcript","target_language"],notes:"Requires speaker alignment, consent and subtitle/audio QA."},
 {id:"speech.isolation",label:"Voice isolation",status:"documented_not_integrated",endpoint:"Provider-specific audio operation",billingRisk:"billable",inputRoles:["source_audio"],notes:"Output quality and channel count must be verified."},
 {id:"video.multi_shot",label:"Multi-shot video recipe",status:"documented_not_integrated",endpoint:"POST /v1/recipes/multi_shot_video",billingRisk:"billable",inputRoles:["story_prompt","shot_list"],notes:"Each shot must remain individually editable, reviewable and regenerable."},
 {id:"video.model_router",label:"Model Router and dry-run preflight",status:"documented_not_integrated",endpoint:"POST /v1/generate/video",billingRisk:"billable_after_preflight",inputRoles:["router_config","normalized_prompt"],notes:"Dry-run preflight must be proven non-billable and bound to a pinned routing configuration before adoption."}
]);

const STATUS_ORDER=Object.freeze(["specified","implemented","contract_tested","configured","staging_tested","live_verified","enabled"]);
function modelOperationStatus(operation,models){
 if(operation.status==="implemented")return "implemented";
 return operation.status;
}
export function getProviderCapabilityAtlas({runwayModel=""}={}){
 const models=listRunwayVideoModels().map(model=>{
  const selected=model.id===runwayModel;
  const caps=getRunwayVideoCapabilities(model.id);
  return {
   id:model.id,label:model.label,selected,
   adapterStatus:"implemented",
   executionStatus:selected?"requires_provider_readiness":"not_selected",
   inputModes:[...model.inputModes],
   constraints:{
    minDurationSeconds:model.minDurationSeconds,
    maxDurationSeconds:model.maxDurationSeconds,
    aspectRatios:[...model.aspectRatios],
    resolutions:[...model.resolutions],
    startFrame:Boolean(caps.startFrame),
    endFrame:Boolean(caps.endFrame),
    multipleReferenceImages:Boolean(caps.referenceImages),
    audioModes:[...caps.audioModes]
   }
  };
 });
 const operations=RUNWAY_OPERATIONS.map(operation=>({
  ...operation,
  status:modelOperationStatus(operation,models),
  evidence:{source:"Runway Dev API documentation",url:RUNWAY_DOCS,checkedAt:"2026-11-08"},
  readinessStages:STATUS_ORDER.map(stage=>({stage,status:stage==="specified"?"evidence_available":stage==="implemented"&&operation.status==="implemented"?"implemented": "not_verified"}))
 }));
 return {
  version:2,
  generatedAt:new Date().toISOString(),
  providers:[{
   id:"runway",
   label:"Runway Dev",
   documentationUrl:RUNWAY_DOCS,
   models,
   operations,
   policy:{
    credentialsExposed:false,
    requestsSubmitted:false,
    pricesEstimated:false,
    paidExecutionRequiresExplicitOptIn:true,
    unimplementedOperationsAreDisabled:true
   }
  }],
  summary:{
   providers:1,
   models:models.length,
   operations:operations.length,
   implementedOperations:operations.filter(x=>x.status==="implemented").length,
   documentedNotIntegrated:operations.filter(x=>x.status==="documented_not_integrated").length
  }
 };
}
