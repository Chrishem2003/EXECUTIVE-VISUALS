import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const DEFAULT_MAX_BYTES=250*1024*1024;
async function hashFile(filePath){
 const hash=createHash("sha256");let size=0;
 for await(const chunk of createReadStream(filePath)){size+=chunk.length;hash.update(chunk);}
 return{size,sha256:hash.digest("hex")};
}
function failure(code,message,status=422){const error=new Error(message);error.code=code;error.status=status;return error;}

/**
 * Creates an opt-in C2PA lineage-preserving transformation step.
 * The caller must supply an authorized signer; this module never loads or creates keys.
 * The original output is replaced only after the signed output is parsed and verified.
 */
export function createC2paTransformationPreserver({sdkLoader=()=>import("@contentauth/c2pa-node"),maxBytes=DEFAULT_MAX_BYTES}={}){
 if(typeof sdkLoader!=="function")throw new TypeError("C2PA SDK loader must be a function.");
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>2*1024*1024*1024)throw new TypeError("C2PA transformation size limit is invalid.");
 return async function preserveC2paTransformation({
  sourcePath,outputPath,sourceMimeType,outputMimeType,signer,signerMode="local",
  operation="edit",softwareName="Executive Visuals",softwareVersion="0.1.0",signal
 }={}){
  if(typeof sourcePath!=="string"||!sourcePath||typeof outputPath!=="string"||!outputPath||sourcePath===outputPath)throw failure("C2PA_TRANSFORM_PATH_INVALID","Distinct source and output file paths are required.");
  if(typeof sourceMimeType!=="string"||!sourceMimeType.includes("/")||typeof outputMimeType!=="string"||!outputMimeType.includes("/"))throw failure("C2PA_TRANSFORM_MEDIA_TYPE_INVALID","Source and output media types are required.");
  if(typeof operation!=="string"||!operation.trim()||operation.length>120)throw failure("C2PA_TRANSFORM_OPERATION_INVALID","A bounded transformation operation is required.");
  if(signal?.aborted)throw signal.reason||failure("C2PA_TRANSFORM_ABORTED","C2PA preservation was cancelled.",499);
  const sourceInfo=await stat(sourcePath).catch(()=>null),outputInfo=await stat(outputPath).catch(()=>null);
  if(!sourceInfo?.isFile()||!outputInfo?.isFile())throw failure("C2PA_TRANSFORM_FILE_MISSING","Source and transformed output files must exist.");
  if(sourceInfo.size<1||outputInfo.size<1||sourceInfo.size>maxBytes||outputInfo.size>maxBytes)throw failure("C2PA_TRANSFORM_SIZE_UNSUPPORTED","Source or output exceeds the C2PA preservation size limit.",413);
  const sourceHash=await hashFile(sourcePath),outputHash=await hashFile(outputPath);
  if(sourceHash.size!==sourceInfo.size||outputHash.size!==outputInfo.size)throw failure("C2PA_TRANSFORM_FILE_CHANGED","Source or output changed during preflight.",409);
  let sdk;
  try{sdk=await sdkLoader();}catch{throw failure("C2PA_SDK_UNAVAILABLE","The official CAI C2PA Node SDK is unavailable.",503);}
  if(!sdk?.Reader||!sdk?.Builder||!sdk?.Context)throw failure("C2PA_SDK_INVALID","The installed CAI SDK does not expose Reader, Builder and Context APIs.",503);
  const verifyContext=new sdk.Context({verify:{verifyAfterReading:true,verifyTrust:true,ocspFetch:false,remoteManifestFetch:false}});
  let sourceReader;
  try{sourceReader=await sdk.Reader.fromAsset({path:sourcePath,mimeType:sourceMimeType},verifyContext);}catch{
   throw failure("C2PA_SOURCE_MANIFEST_INVALID","The source C2PA manifest could not be parsed; transformation lineage was not signed.");
  }
  if(typeof sourceReader.isEmbedded==="function"&&!sourceReader.isEmbedded())return{
   status:"not_present",preserved:false,sourceSha256:sourceHash.sha256,outputSha256:outputHash.sha256,
   reason:"SOURCE_C2PA_MANIFEST_NOT_PRESENT"
  };
  const sourceStore=sourceReader.json();
  if(!sourceStore?.active_manifest||!sourceStore?.manifests||sourceStore.validation_state==="Invalid")throw failure("C2PA_SOURCE_MANIFEST_INVALID","The source C2PA manifest is invalid; transformation lineage was not signed.");
  if(!signer||typeof signer.sign!=="function")throw failure("C2PA_SIGNER_REQUIRED","An approved C2PA signer must be supplied by the server-side signing adapter.",503);
  if(!["local","callback"].includes(signerMode))throw failure("C2PA_SIGNER_MODE_INVALID","Unsupported C2PA signer mode.");
  const builder=await sdk.Builder.newAsync();
  builder.addIngredientFromReader(sourceReader);
  builder.setIntent("edit");
  builder.addAction(JSON.stringify({
   action:"c2pa.edited",
   softwareAgent:{name:softwareName,version:softwareVersion},
   parameters:{operation}
  }));
  const temporaryPath=join(dirname(outputPath),"."+randomUUID()+".c2pa-tmp");
  try{
   const input={path:outputPath,mimeType:outputMimeType};
   const destination={path:temporaryPath,mimeType:outputMimeType};
   if(signerMode==="callback")await builder.signAsync(signer,input,destination);
   else builder.sign(signer,input,destination);
   if(signal?.aborted)throw signal.reason||failure("C2PA_TRANSFORM_ABORTED","C2PA preservation was cancelled.",499);
   const signedInfo=await stat(temporaryPath).catch(()=>null);
   if(!signedInfo?.isFile()||signedInfo.size<1||signedInfo.size>maxBytes)throw failure("C2PA_SIGNED_OUTPUT_INVALID","The signed transformation output is missing or exceeds the size limit.");
   const signedHash=await hashFile(temporaryPath);
   const signedReader=await sdk.Reader.fromAsset({path:temporaryPath,mimeType:outputMimeType},verifyContext);
   const signedStore=signedReader.json();
   const active=signedStore?.active_manifest&&signedStore?.manifests?.[signedStore.active_manifest];
   const ingredients=Array.isArray(active?.ingredients)?active.ingredients:[];
   if(!signedReader.isEmbedded()||!signedStore?.active_manifest||signedStore.validation_state==="Invalid"||!ingredients.some(item=>Boolean(item?.manifest_data)))throw failure("C2PA_LINEAGE_VALIDATION_FAILED","The new C2PA manifest did not validate with the source manifest preserved as an ingredient.");
   const currentSource=await hashFile(sourcePath);
   if(currentSource.sha256!==sourceHash.sha256||currentSource.size!==sourceHash.size)throw failure("C2PA_SOURCE_CHANGED","The source asset changed while its C2PA lineage was being preserved.",409);
   if(signal?.aborted)throw signal.reason||failure("C2PA_TRANSFORM_ABORTED","C2PA preservation was cancelled.",499);
   await rename(temporaryPath,outputPath);
   return{
    status:"preserved",preserved:true,sourceValidationState:sourceStore.validation_state||"unknown",
    outputValidationState:signedStore.validation_state||"unknown",ingredientCount:ingredients.length,
    sourceSha256:sourceHash.sha256,outputSha256:signedHash.sha256,outputBytes:signedHash.size,
    operation
   };
  }finally{await unlink(temporaryPath).catch(()=>{});}
}
}
