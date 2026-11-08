import { X509Certificate } from "node:crypto";

const ALGORITHMS=new Set(["ed25519","es256","es384","es512","ps256","ps384","ps512"]);
function failure(code,message,status=422){const error=new Error(message);error.code=code;error.status=status;return error;}
function throwIfAborted(signal){
 if(!signal?.aborted)return;
 if(signal.reason&&typeof signal.reason==="object"&&typeof signal.reason.code==="string")throw signal.reason;
 throw failure("C2PA_TRANSFORM_ABORTED","C2PA callback signing was cancelled.",499);
}

/**
 * Builds the official CAI CallbackSigner around an externally managed signing
 * operation. This module accepts public certificates and a signing callback;
 * it never accepts, stores or loads private-key material.
 */
export async function createC2paCallbackSigner({
 sdkLoader=()=>import("@contentauth/c2pa-node"),
 algorithm,
 certificateChain,
 reserveSize=4096,
 tsaUrl,
 sign,
 signal
}={}){
 if(typeof sdkLoader!=="function")throw new TypeError("C2PA SDK loader must be a function.");
 if(!ALGORITHMS.has(algorithm))throw failure("C2PA_CALLBACK_ALGORITHM_UNSUPPORTED","The callback signer algorithm is unsupported.");
 if(!Array.isArray(certificateChain)||certificateChain.length<1||certificateChain.length>8)throw failure("C2PA_CALLBACK_CERTIFICATES_INVALID","A callback signer requires between one and eight public certificates.");
 if(!Number.isSafeInteger(reserveSize)||reserveSize<512||reserveSize>65536)throw failure("C2PA_CALLBACK_RESERVE_SIZE_INVALID","The callback signature reserve size is outside the supported range.");
 if(tsaUrl!==undefined){
  let url;try{url=new URL(tsaUrl);}catch{throw failure("C2PA_CALLBACK_TSA_URL_INVALID","The timestamp authority URL is invalid.");}
  if(url.protocol!=="https:")throw failure("C2PA_CALLBACK_TSA_URL_INVALID","The timestamp authority must use HTTPS.");
 }
 if(typeof sign!=="function")throw failure("C2PA_CALLBACK_REQUIRED","A protected signing callback is required.");
 const certs=certificateChain.map(value=>{
  const cert=Buffer.isBuffer(value)?Buffer.from(value):Buffer.from(String(value),"utf8");
  try{new X509Certificate(cert);}catch{throw failure("C2PA_CALLBACK_CERTIFICATES_INVALID","A callback signer certificate is not a valid X.509 certificate.");}
  return cert;
 });
 const totalCertificateBytes=certs.reduce((total,cert)=>total+cert.length,0);
 if(totalCertificateBytes>256*1024)throw failure("C2PA_CALLBACK_CERTIFICATES_INVALID","The callback signer certificate chain exceeds the size limit.");
 throwIfAborted(signal);
 let sdk;try{sdk=await sdkLoader();}catch{throw failure("C2PA_SDK_UNAVAILABLE","The official CAI C2PA Node SDK is unavailable.",503);}
 throwIfAborted(signal);
 if(typeof sdk?.CallbackSigner?.newSigner!=="function")throw failure("C2PA_CALLBACK_SIGNER_UNAVAILABLE","The installed CAI SDK does not expose CallbackSigner.newSigner.",503);
 return sdk.CallbackSigner.newSigner({
  alg:algorithm,certs,directCoseHandling:false,reserveSize,
  ...(tsaUrl?{tsaUrl}: {})
 },async data=>{
  throwIfAborted(signal);
  if(!Buffer.isBuffer(data)||data.length<1)throw failure("C2PA_CALLBACK_PAYLOAD_INVALID","The CAI SDK supplied an invalid signing payload.");
  let signature;
  try{signature=await sign(Buffer.from(data),{algorithm,signal});}
  catch(error){
   if(signal?.aborted)throwIfAborted(signal);
   throw failure("C2PA_CALLBACK_SIGNER_FAILED","The protected signing callback failed.",503);
  }
  throwIfAborted(signal);
  if(!Buffer.isBuffer(signature)||signature.length<1||signature.length>reserveSize)throw failure("C2PA_CALLBACK_SIGNATURE_INVALID","The protected signer returned an invalid or oversized signature.",503);
  return signature;
 });
}
