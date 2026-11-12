import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const SHA256=/^[a-f0-9]{64}$/i;
const DEFAULT_MAX_BYTES=250*1024*1024;
const MAX_VALIDATION_ITEMS=100;
const SUPPORTED_C2PA_MEDIA_TYPES=new Set(["image/jpeg","image/png","image/webp","image/gif","audio/mpeg","audio/wav","audio/x-wav","audio/mp4","video/mp4","video/quicktime","application/pdf"]);

function fail(code,message,status=422){
 const error=new Error(message);error.code=code;error.status=status;return error;
}
async function hashFile(filePath){
 const hash=createHash("sha256");let size=0;
 for await(const chunk of createReadStream(filePath)){size+=chunk.length;hash.update(chunk);}
 return{size,sha256:hash.digest("hex")};
}
function safeText(value,max=500){
 return typeof value==="string"?value.slice(0,max):null;
}
function safeStatus(item){
 if(!item||typeof item!=="object")return null;
 return{
  code:safeText(item.code,160)||"UNKNOWN_VALIDATION_CODE",
  success:typeof item.success==="boolean"?item.success:null,
  explanation:safeText(item.explanation,500)
 };
}
function statusItems(store){
 const values=[];
 const top=Array.isArray(store.validation_status)?store.validation_status:[];
 values.push(...top);
 const active=store.validation_results?.activeManifest;
 if(Array.isArray(active))values.push(...active);
 else if(active&&typeof active==="object"){
  for(const key of ["success","informational","failure"])if(Array.isArray(active[key]))values.push(...active[key]);
 }
 return values.slice(0,MAX_VALIDATION_ITEMS).map(safeStatus).filter(Boolean);
}
function summarizeManifest(store){
 const label=store.active_manifest;
 const manifest=label&&store.manifests&&typeof store.manifests==="object"?store.manifests[label]:null;
 if(!manifest||typeof manifest!=="object")return null;
 const ingredients=Array.isArray(manifest.ingredients)?manifest.ingredients:[];
 return{
  activeManifestLabel:safeText(label,256),
  title:safeText(manifest.title,256),
  format:safeText(manifest.format,128),
  claimGenerator:safeText(manifest.claim_generator,256),
  claimGeneratorInfo:Array.isArray(manifest.claim_generator_info)?manifest.claim_generator_info.slice(0,10).map(item=>({
   name:safeText(item?.name,128),version:safeText(item?.version,64),icon:safeText(item?.icon,256)
  })):[],
  ingredientCount:ingredients.length,
  ingredients:ingredients.slice(0,50).map(item=>({
   title:safeText(item?.title,256),format:safeText(item?.format,128),
   relationship:safeText(item?.relationship,64),instanceId:safeText(item?.instance_id,256),
   hasManifestData:Boolean(item?.manifest_data)
  }))
 };
}
function verificationState(store){
 const value=store.validation_state;
 if(value==="Trusted")return"trusted";
 if(value==="Valid")return"valid_untrusted";
 if(value==="Invalid")return"invalid";
 return"validation_unavailable";
}

export function createC2paVerifier({sdkLoader=()=>import("@contentauth/c2pa-node"),maxBytes=DEFAULT_MAX_BYTES,trustAnchorsPath=process.env.C2PA_TRUST_ANCHORS_PATH||null,userAnchorsPath=process.env.C2PA_USER_ANCHORS_PATH||null}={}){
 if(typeof sdkLoader!=="function")throw new TypeError("C2PA SDK loader must be a function.");
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>2*1024*1024*1024)throw new TypeError("C2PA asset size limit is invalid.");
 return async function verifyC2paAsset({filePath,mediaType,expectedSha256,expectedSize}={}){
  if(typeof filePath!=="string"||!filePath)throw fail("C2PA_ASSET_PATH_REQUIRED","A stored asset path is required.");
  if(typeof mediaType!=="string"||!mediaType.includes("/"))throw fail("C2PA_MEDIA_TYPE_REQUIRED","A valid media type is required.");
  const normalizedMediaType=mediaType.split(";")[0].trim().toLowerCase();
  if(typeof expectedSha256!=="string"||!SHA256.test(expectedSha256))throw fail("C2PA_ASSET_HASH_REQUIRED","A valid stored SHA-256 is required.");
  const before=await stat(filePath).catch(()=>null);
  if(!before?.isFile())throw fail("C2PA_ASSET_NOT_FOUND","The stored media asset is unavailable.",404);
  if(before.size<1||before.size>maxBytes)throw fail("C2PA_ASSET_SIZE_UNSUPPORTED","The asset is empty or exceeds the C2PA inspection size limit.",413);
  if(expectedSize!==undefined&&Number(expectedSize)!==before.size)throw fail("C2PA_ASSET_SIZE_MISMATCH","The stored asset size no longer matches its metadata.",409);
  const first=await hashFile(filePath);
  if(first.size!==before.size||first.sha256!==expectedSha256.toLowerCase())throw fail("C2PA_ASSET_INTEGRITY_MISMATCH","The stored asset does not match its registered SHA-256.",409);
  if(!SUPPORTED_C2PA_MEDIA_TYPES.has(normalizedMediaType))return{
   status:"validation_unavailable",present:null,valid:false,trusted:false,assetSha256:first.sha256,
   validationState:null,findings:["C2PA_FORMAT_UNSUPPORTED"],manifest:null,validationStatuses:[]
  };
  let sdk;
  try{sdk=await sdkLoader();}catch{throw fail("C2PA_SDK_UNAVAILABLE","The official CAI C2PA Node SDK is unavailable.",503);}
  if(!sdk?.Reader||!sdk?.Context)throw fail("C2PA_SDK_INVALID","The installed CAI C2PA SDK does not expose the required Reader and Context APIs.",503);
  const settings={verify:{verifyAfterReading:true,verifyTrust:true,verifyTimestampTrust:true,ocspFetch:false,remoteManifestFetch:false}};
  if(trustAnchorsPath||userAnchorsPath){
   settings.trust={};
   if(trustAnchorsPath)settings.trust.trustAnchors=trustAnchorsPath;
   if(userAnchorsPath)settings.trust.userAnchors=userAnchorsPath;
  }
  let reader;
  try{
   reader=await sdk.Reader.fromAsset({path:filePath,mimeType:normalizedMediaType},new sdk.Context(settings));
  }catch{
   const after=await stat(filePath).catch(()=>null);
   const current=after?.isFile()?await hashFile(filePath).catch(()=>null):null;
   if(!after||!current||current.size!==before.size||current.sha256!==first.sha256)throw fail("C2PA_ASSET_CHANGED_DURING_READ","The asset changed during C2PA inspection.",409);
   return{status:"invalid",present:true,valid:false,trusted:false,assetSha256:first.sha256,validationState:"Invalid",findings:["C2PA_READER_REJECTED_ASSET"],manifest:null,validationStatuses:[]};
  }
  const after=await stat(filePath).catch(()=>null);
  const finalHash=after?.isFile()?await hashFile(filePath).catch(()=>null):null;
  if(!after||!finalHash||finalHash.size!==before.size||finalHash.sha256!==first.sha256)throw fail("C2PA_ASSET_CHANGED_DURING_READ","The asset changed during C2PA inspection.",409);
  if(!reader)return{
   status:"not_present",present:false,valid:false,trusted:false,assetSha256:first.sha256,
   validationState:null,findings:["C2PA_MANIFEST_NOT_PRESENT"],manifest:null,validationStatuses:[]
  };
  const embedded=typeof reader.isEmbedded==="function"?reader.isEmbedded():true;
  const remoteUrl=typeof reader.remoteUrl==="function"?reader.remoteUrl():null;
  if(!embedded&&remoteUrl)return{
   status:"validation_unavailable",present:true,valid:false,trusted:false,assetSha256:first.sha256,
   validationState:null,findings:["C2PA_REMOTE_MANIFEST_FETCH_DISABLED"],manifest:null,validationStatuses:[]
  };
  if(!embedded)return{
   status:"not_present",present:false,valid:false,trusted:false,assetSha256:first.sha256,
   validationState:null,findings:["C2PA_MANIFEST_NOT_PRESENT"],manifest:null,validationStatuses:[]
  };
  const store=reader.json();
  if(!store||typeof store!=="object"||!store.active_manifest||!store.manifests||typeof store.manifests!=="object")return{
   status:"not_present",present:false,valid:false,trusted:false,assetSha256:first.sha256,
   validationState:null,findings:["C2PA_MANIFEST_NOT_PRESENT"],manifest:null,validationStatuses:[]
  };
  const state=verificationState(store);
  const validationStatuses=statusItems(store);
  const failures=validationStatuses.filter(item=>item.success===false).map(item=>item.code);
  const findings=[...new Set(failures)];
  if(state==="invalid"&&!findings.length)findings.push("C2PA_VALIDATION_FAILED");
  if(state==="validation_unavailable")findings.push("C2PA_VALIDATION_STATE_UNAVAILABLE");
  return{
   status:state,present:true,valid:state==="trusted"||state==="valid_untrusted",
   trusted:state==="trusted",assetSha256:first.sha256,validationState:store.validation_state||null,
   findings,manifest:summarizeManifest(store),validationStatuses
  };
 };
}

export const verifyC2paAsset=createC2paVerifier();
