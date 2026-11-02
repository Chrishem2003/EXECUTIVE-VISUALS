import { createHash, randomUUID } from "node:crypto";
const OPERATIONS=new Set(["vehicle_replace","wardrobe_replace","object_replace","background_replace","person_replace","style_transfer","object_remove","relight"]);
const PRESERVATION=new Set(["camera_motion","timing","composition","source_audio","subject_identity","pose","lighting","background"]);
const DEFAULT_PRESERVATION=["camera_motion","timing","composition","source_audio"];
export class VideoTransformationValidationError extends Error{
 constructor(message,code="VIDEO_TRANSFORM_INVALID_REQUEST"){super(message);this.name="VideoTransformationValidationError";this.code=code;}
}
function requiredText(value,label,maxLength){
 if(typeof value!=="string"||!value.trim())throw new VideoTransformationValidationError(label+" is required");
 const normalized=value.trim();if(normalized.length>maxLength)throw new VideoTransformationValidationError(label+" exceeds "+maxLength+" characters");return normalized;
}
function assetIds(value){
 if(value==null)return [];
 if(!Array.isArray(value)||value.length>4)throw new VideoTransformationValidationError("referenceAssetIds must contain at most 4 asset IDs");
 const ids=value.map(id=>requiredText(id,"reference asset ID",160));
 if(new Set(ids).size!==ids.length)throw new VideoTransformationValidationError("referenceAssetIds cannot contain duplicates");return ids;
}
/** Validate a video-to-video transformation draft. No upload, provider call, spend or execution occurs here. */
export function normalizeVideoTransformationRequest(input){
 if(!input||typeof input!=="object"||Array.isArray(input))throw new VideoTransformationValidationError("Request must be an object");
 const allowed=new Set(["requestId","projectId","sourceAsset","operation","targetDescription","prompt","referenceAssetIds","durationSeconds","preserve","consent"]);
 if(Object.keys(input).some(key=>!allowed.has(key)))throw new VideoTransformationValidationError("Request contains unsupported fields","VIDEO_TRANSFORM_FIELD_UNSUPPORTED");
 const source=input.sourceAsset;
 if(!source||typeof source!=="object"||Array.isArray(source)||typeof source.id!=="string"||!source.id.trim()||typeof source.media_type!=="string"||!source.media_type.startsWith("video/"))
  throw new VideoTransformationValidationError("A source video asset ID and video media type are required","VIDEO_TRANSFORM_SOURCE_INVALID");
 if(source.sha256!=null&&(typeof source.sha256!=="string"||!/^[a-f0-9]{64}$/i.test(source.sha256)))throw new VideoTransformationValidationError("Source asset checksum is invalid","VIDEO_TRANSFORM_SOURCE_INVALID");
 const operation=requiredText(input.operation,"operation",40);
 if(!OPERATIONS.has(operation))throw new VideoTransformationValidationError("Transformation operation is not supported by the normalized contract","VIDEO_TRANSFORM_OPERATION_UNSUPPORTED");
 const durationSeconds=input.durationSeconds??5;
 if(!Number.isInteger(durationSeconds)||durationSeconds<1||durationSeconds>30)throw new VideoTransformationValidationError("durationSeconds must be an integer between 1 and 30");
 const preserve=input.preserve??DEFAULT_PRESERVATION;
 if(!Array.isArray(preserve)||preserve.length>PRESERVATION.size||preserve.some(item=>typeof item!=="string"||!PRESERVATION.has(item))||new Set(preserve).size!==preserve.length)
  throw new VideoTransformationValidationError("preserve contains an unsupported or duplicate preservation option");
 const consent=input.consent;
 if(!consent||consent.rightsConfirmed!==true)throw new VideoTransformationValidationError("Confirm that you have rights to use the source and reference media","VIDEO_TRANSFORM_RIGHTS_REQUIRED");
 if(operation==="person_replace"&&consent.subjectConsentConfirmed!==true)throw new VideoTransformationValidationError("Person replacement requires explicit subject consent","VIDEO_TRANSFORM_SUBJECT_CONSENT_REQUIRED");
 const sourceAsset=Object.freeze({id:requiredText(source.id,"source asset ID",160),media_type:source.media_type,...(source.sha256?{sha256:source.sha256.toLowerCase()}:{})});
 return Object.freeze({
  requestId:input.requestId==null?randomUUID():requiredText(input.requestId,"requestId",160),
  ...(input.projectId==null?{}:{projectId:requiredText(input.projectId,"projectId",160)}),
  sourceAsset,operation,targetDescription:requiredText(input.targetDescription,"targetDescription",500),
  prompt:requiredText(input.prompt,"prompt",6000),referenceAssetIds:assetIds(input.referenceAssetIds),
  durationSeconds,preserve:[...preserve],
  consent:Object.freeze({rightsConfirmed:true,subjectConsentConfirmed:consent.subjectConsentConfirmed===true}),
  execution:Object.freeze({mode:"draft",submitted:false,requiresApproval:true,estimatedCost:null})
 });
}
/** Fail closed unless the adapter declares the operation and requested preservation. */
export function assertTransformationCapabilities(request,capabilities={}){
 if(!Array.isArray(capabilities.operations)||!capabilities.operations.includes(request.operation))
  throw new VideoTransformationValidationError("Selected provider/model does not declare support for this transformation","VIDEO_TRANSFORM_UNSUPPORTED_CAPABILITY");
 if(capabilities.maxDurationSeconds!=null&&request.durationSeconds>capabilities.maxDurationSeconds)
  throw new VideoTransformationValidationError("Requested clip exceeds the provider/model duration limit","VIDEO_TRANSFORM_UNSUPPORTED_CAPABILITY");
 if(request.referenceAssetIds.length>0&&(capabilities.maxReferenceImages==null||request.referenceAssetIds.length>capabilities.maxReferenceImages))
  throw new VideoTransformationValidationError("Selected provider/model does not declare support for this number of reference images","VIDEO_TRANSFORM_UNSUPPORTED_CAPABILITY");
 const supported=new Set(capabilities.preserves||[]);
 if(request.preserve.some(item=>!supported.has(item)))throw new VideoTransformationValidationError("Selected provider/model cannot guarantee all requested preservation constraints","VIDEO_TRANSFORM_UNSUPPORTED_PRESERVATION");
 return true;
}
export function createTransformationProvenance(request,{provider,model,adapterVersion="1"}={}){
 const normalized=normalizeVideoTransformationRequest(request);
 const requestHash=createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
 return Object.freeze({requestId:normalized.requestId,projectId:normalized.projectId,sourceAssetId:normalized.sourceAsset.id,sourceSha256:normalized.sourceAsset.sha256||null,provider:provider||"unselected",model:model||"unselected",adapterVersion,requestHash,createdAt:new Date().toISOString(),executionSubmitted:false});
}
