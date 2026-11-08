import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const DEFAULT_MAX_BYTES=250*1024*1024;
function throwIfAborted(signal){
 if(!signal?.aborted)return;
 if(signal.reason&&typeof signal.reason==="object"&&typeof signal.reason.code==="string")throw signal.reason;
 const error=failure("C2PA_TRANSFORM_ABORTED","C2PA preservation was cancelled.",499);
 error.name="AbortError";
 throw error;
}
async function hashFile(filePath,signal){
 const hash=createHash("sha256");let size=0;
 try{
  const streamOptions=typeof signal?.addEventListener==="function"?{signal}:{};
  for await(const chunk of createReadStream(filePath,streamOptions)){
   throwIfAborted(signal);
   size+=chunk.length;hash.update(chunk);
  }
 }catch(error){
  if(signal?.aborted)throwIfAborted(signal);
  throw error;
 }
 throwIfAborted(signal);
 return{size,sha256:hash.digest("hex")};
}
function failure(code,message,status=422){const error=new Error(message);error.code=code;error.status=status;return error;}
function safeIngredientTitle(value,fallback){return typeof value==="string"&&value.trim()?value.slice(0,256):String(fallback||"source-asset").slice(0,256);}

/**
 * Creates an opt-in C2PA lineage-preserving transformation step.
 * Every credential-bearing source is carried as a parent ingredient.
 * The caller supplies an authorized signer; this module never loads or creates keys.
 */
export function createC2paTransformationPreserver({sdkLoader=()=>import("@contentauth/c2pa-node"),maxBytes=DEFAULT_MAX_BYTES}={}){
 if(typeof sdkLoader!=="function")throw new TypeError("C2PA SDK loader must be a function.");
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>2*1024*1024*1024)throw new TypeError("C2PA transformation size limit is invalid.");
 return async function preserveC2paTransformation({
  sources=null,sourcePath=null,sourceMimeType=null,expectedSourceSha256=null,
  outputPath,outputMimeType,signer,signerMode="local",
  operation="edit",softwareName="Executive Visuals",softwareVersion="0.1.0",signal
 }={}){
  if(typeof outputPath!=="string"||!outputPath)throw failure("C2PA_TRANSFORM_PATH_INVALID","A distinct output file path is required.");
  if(typeof outputMimeType!=="string"||!outputMimeType.includes("/"))throw failure("C2PA_TRANSFORM_MEDIA_TYPE_INVALID","An output media type is required.");
  if(typeof operation!=="string"||!operation.trim()||operation.length>120)throw failure("C2PA_TRANSFORM_OPERATION_INVALID","A bounded transformation operation is required.");
  const inputSources=Array.isArray(sources)?sources:(sourcePath?[{path:sourcePath,mediaType:sourceMimeType,sha256:expectedSourceSha256}]:[]);
  if(!inputSources.length||inputSources.length>5000)throw failure("C2PA_SOURCE_ASSETS_INVALID","Between one and 5,000 source assets are required.");
  throwIfAborted(signal);
  const prepared=[];
  for(const source of inputSources){
   if(typeof source?.path!=="string"||!source.path||source.path===outputPath||typeof source.mediaType!=="string"||!source.mediaType.includes("/"))throw failure("C2PA_TRANSFORM_PATH_INVALID","Each source requires a distinct path and valid media type.");
   const info=await stat(source.path).catch(()=>null);
   if(!info?.isFile()||info.size<1||info.size>maxBytes)throw failure("C2PA_TRANSFORM_SIZE_UNSUPPORTED","A source asset is missing, empty or exceeds the C2PA preservation size limit.",413);
   const hash=await hashFile(source.path,signal);
   if(hash.size!==info.size)throw failure("C2PA_TRANSFORM_FILE_CHANGED","A source changed during preflight.",409);
   if(source.sha256!==undefined&&source.sha256!==null&&(!/^[a-f0-9]{64}$/i.test(String(source.sha256))||hash.sha256!==String(source.sha256).toLowerCase()))throw failure("C2PA_SOURCE_INTEGRITY_MISMATCH","A source file does not match its registered asset checksum.",409);
   prepared.push({...source,info,hash});
  }
  const outputInfo=await stat(outputPath).catch(()=>null);
  if(!outputInfo?.isFile()||outputInfo.size<1||outputInfo.size>maxBytes)throw failure("C2PA_TRANSFORM_SIZE_UNSUPPORTED","The transformed output is missing, empty or exceeds the C2PA preservation size limit.",413);
  const outputHash=await hashFile(outputPath,signal);
  if(outputHash.size!==outputInfo.size)throw failure("C2PA_TRANSFORM_FILE_CHANGED","The transformed output changed during preflight.",409);
  let sdk;
  try{sdk=await sdkLoader();}catch{throw failure("C2PA_SDK_UNAVAILABLE","The official CAI C2PA Node SDK is unavailable.",503);}
  throwIfAborted(signal);
  if(!sdk?.Reader||!sdk?.Builder||!sdk?.Context)throw failure("C2PA_SDK_INVALID","The installed CAI SDK does not expose Reader, Builder and Context APIs.",503);
  const verifyContext=new sdk.Context({verify:{verifyAfterReading:true,verifyTrust:true,ocspFetch:false,remoteManifestFetch:false}});
  const credentialSources=[];
  for(const source of prepared){
   let reader;
   try{reader=await sdk.Reader.fromAsset({path:source.path,mimeType:source.mediaType},verifyContext);}catch{
    throw failure("C2PA_SOURCE_MANIFEST_INVALID","A source C2PA manifest could not be parsed; transformation lineage was not signed.");
   }
   throwIfAborted(signal);
   if(!reader)continue;
   const embedded=typeof reader.isEmbedded==="function"?reader.isEmbedded():true;
   const remoteUrl=typeof reader.remoteUrl==="function"?reader.remoteUrl():null;
   if(!embedded&&remoteUrl)throw failure("C2PA_REMOTE_MANIFEST_UNAVAILABLE","A source references a remote C2PA manifest, but remote manifest fetching is disabled; derivative publication is blocked.",503);
   if(!embedded)continue;
   const store=reader.json();
   if(!store?.active_manifest||!store?.manifests||!["Valid","Trusted"].includes(store.validation_state))throw failure("C2PA_SOURCE_MANIFEST_INVALID","A source C2PA manifest is invalid or not fully validated; transformation lineage was not signed.");
   credentialSources.push({source,store});
  }
  if(!credentialSources.length)return{
   status:"not_present",preserved:false,sourceCount:prepared.length,credentialSourceCount:0,
   sourceSha256:prepared.length===1?prepared[0].hash.sha256:null,outputSha256:outputHash.sha256,
   reason:"SOURCE_C2PA_MANIFEST_NOT_PRESENT"
  };
  if(!signer||typeof signer.sign!=="function")throw failure("C2PA_SIGNER_REQUIRED","An approved C2PA signer must be supplied by the server-side signing adapter.",503);
  if(!["local","callback"].includes(signerMode))throw failure("C2PA_SIGNER_MODE_INVALID","Unsupported C2PA signer mode.");
  const builder=await sdk.Builder.newAsync();
  for(let index=0;index<credentialSources.length;index++){
   const {source,store}=credentialSources[index];
   const manifest=store.manifests[store.active_manifest];
   await builder.addIngredient(JSON.stringify({
    title:safeIngredientTitle(manifest?.title,basename(source.path)),
    format:source.mediaType,instance_id:"xmp:iid:"+randomUUID(),
    relationship:index===0?"parentOf":"componentOf"
   }),{path:source.path,mimeType:source.mediaType});
   throwIfAborted(signal);
  }
  builder.setIntent("edit");
  builder.addAction(JSON.stringify({
   action:"c2pa.edited",softwareAgent:{name:softwareName,version:softwareVersion},
   parameters:{operation,sourceCount:prepared.length,credentialSourceCount:credentialSources.length}
  }));
  const temporaryPath=join(dirname(outputPath),"."+randomUUID()+".c2pa-tmp");
  try{
   const input={path:outputPath,mimeType:outputMimeType},destination={path:temporaryPath,mimeType:outputMimeType};
   if(signerMode==="callback")await builder.signAsync(signer,input,destination);else builder.sign(signer,input,destination);
   throwIfAborted(signal);
   const signedInfo=await stat(temporaryPath).catch(()=>null);
   if(!signedInfo?.isFile()||signedInfo.size<1||signedInfo.size>maxBytes)throw failure("C2PA_SIGNED_OUTPUT_INVALID","The signed transformation output is missing or exceeds the size limit.");
   const signedHash=await hashFile(temporaryPath,signal);
   const signedReader=await sdk.Reader.fromAsset({path:temporaryPath,mimeType:outputMimeType},verifyContext);
   throwIfAborted(signal);
   if(!signedReader)throw failure("C2PA_LINEAGE_VALIDATION_FAILED","The signed derivative does not contain an embedded C2PA manifest.");
   const signedStore=signedReader.json(),active=signedStore?.active_manifest&&signedStore?.manifests?.[signedStore.active_manifest];
   const ingredients=Array.isArray(active?.ingredients)?active.ingredients:[];
   const embeddedIngredients=ingredients.filter(item=>Boolean(item?.manifest_data));
   if(!signedReader.isEmbedded()||!active||!["Valid","Trusted"].includes(signedStore.validation_state)||embeddedIngredients.length<credentialSources.length)throw failure("C2PA_LINEAGE_VALIDATION_FAILED","The new C2PA manifest did not validate with every credential-bearing source preserved as an ingredient.");
   for(const source of prepared){
    const current=await hashFile(source.path,signal);
    if(current.sha256!==source.hash.sha256||current.size!==source.hash.size)throw failure("C2PA_SOURCE_CHANGED","A source asset changed while its C2PA lineage was being preserved.",409);
   }
   const currentOutput=await hashFile(outputPath,signal);
   if(currentOutput.sha256!==outputHash.sha256||currentOutput.size!==outputHash.size)throw failure("C2PA_OUTPUT_CHANGED","The transformed output changed while its C2PA manifest was being signed.",409);
   throwIfAborted(signal);
   await rename(temporaryPath,outputPath);
   return{
    status:"preserved",preserved:true,sourceCount:prepared.length,credentialSourceCount:credentialSources.length,
    sourceValidationStates:credentialSources.map(item=>item.store.validation_state||"unknown"),
    outputValidationState:signedStore.validation_state||"unknown",ingredientCount:ingredients.length,
    sourceSha256:prepared.length===1?prepared[0].hash.sha256:null,
    sourceSha256s:prepared.map(item=>item.hash.sha256),outputSha256:signedHash.sha256,
    outputBytes:signedHash.size,operation
   };
  }finally{await unlink(temporaryPath).catch(()=>{});}
 };
}
