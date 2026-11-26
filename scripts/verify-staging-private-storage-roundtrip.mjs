import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { supabaseServerAuthHeaders } from "../server/supabase-server-credentials.mjs";

export const APPROVED_STAGING_PROJECT_REF = "bokxljngydmqrmktofwm";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_RESPONSE_BYTES = 64 * 1024;
const bytesEqual = (a,b) => Buffer.from(a).equals(Buffer.from(b));

function configuration(env) {
  const required = [
    "SUPABASE_STAGING_URL","SUPABASE_STAGING_ANON_KEY","SUPABASE_STAGING_SECRET_KEY",
    "STORAGE_TEST_OWNER_JWT","STORAGE_TEST_OTHER_JWT","STORAGE_TEST_OWNER_ID"
  ];
  const missing = required.filter(name => !String(env[name] || "").trim());
  if (missing.length) throw Object.assign(new Error("Staging private-storage test configuration is incomplete."), {
    code:"STAGING_STORAGE_CONFIG_MISSING", missing
  });
  const url = new URL(env.SUPABASE_STAGING_URL);
  if (url.protocol !== "https:" || url.hostname !== `${APPROVED_STAGING_PROJECT_REF}.supabase.co` ||
      url.username || url.password || url.search || url.hash) {
    throw Object.assign(new Error("Staging storage test is not pointed at the approved Supabase project."), {code:"STAGING_STORAGE_PROJECT_INVALID"});
  }
  const ownerId = String(env.STORAGE_TEST_OWNER_ID);
  if (!UUID.test(ownerId)) throw Object.assign(new Error("Storage test owner identity is invalid."), {code:"STAGING_STORAGE_OWNER_INVALID"});
  const bucket = String(env.SUPABASE_STAGING_BUCKET || "executive-visuals-media").trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw Object.assign(new Error("Staging storage bucket identifier is invalid."), {code:"STAGING_STORAGE_BUCKET_INVALID"});
  }
  return {origin:url.origin,ownerId,bucket,anonKey:env.SUPABASE_STAGING_ANON_KEY,
    secretKey:env.SUPABASE_STAGING_SECRET_KEY,ownerJwt:env.STORAGE_TEST_OWNER_JWT,otherJwt:env.STORAGE_TEST_OTHER_JWT};
}

async function readBytes(response, maxBytes=MAX_RESPONSE_BYTES) {
  const declared=Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared>maxBytes) throw Object.assign(new Error("Storage test response exceeded its safety limit."),{code:"STAGING_STORAGE_RESPONSE_TOO_LARGE"});
  const data=new Uint8Array(await response.arrayBuffer());
  if(data.byteLength>maxBytes)throw Object.assign(new Error("Storage test response exceeded its safety limit."),{code:"STAGING_STORAGE_RESPONSE_TOO_LARGE"});
  return data;
}

function safeFailure(code,message,status) {
  return Object.assign(new Error(message),{code,status});
}

export async function runPrivateStorageRoundTrip({
  env=process.env,fetchImpl=globalThis.fetch,createId=randomUUID,now=Date.now
}={}) {
  if(typeof fetchImpl!=="function")throw new Error("A fetch implementation is required.");
  const config=configuration(env);
  const serverHeaders=supabaseServerAuthHeaders(config.secretKey);
  const authUser=async jwt=>{
    const response=await fetchImpl(config.origin+"/auth/v1/user",{
      method:"GET",headers:{apikey:config.anonKey,authorization:"Bearer "+jwt,accept:"application/json"},
      redirect:"error"
    });
    if(!response.ok)throw safeFailure("STAGING_STORAGE_TEST_IDENTITY_INVALID","A staging storage test JWT could not be verified.",response.status);
    let user;
    try{user=await response.json();}catch{throw safeFailure("STAGING_STORAGE_AUTH_RESPONSE_INVALID","Staging Auth returned an invalid test identity.",502);}
    if(!UUID.test(String(user?.id||"")))throw safeFailure("STAGING_STORAGE_AUTH_RESPONSE_INVALID","Staging Auth returned an invalid test identity.",502);
    return String(user.id);
  };
  const ownerId=await authUser(config.ownerJwt);
  const otherId=await authUser(config.otherJwt);
  if(ownerId!==config.ownerId||otherId===ownerId)
    throw safeFailure("STAGING_STORAGE_TEST_IDENTITY_MISMATCH","The configured owner and other-user JWTs do not identify two distinct expected staging users.",409);

  const bucketResponse=await fetchImpl(config.origin+"/storage/v1/bucket/"+encodeURIComponent(config.bucket),{
    method:"GET",headers:{...serverHeaders,accept:"application/json"},redirect:"error"
  });
  if(!bucketResponse.ok)throw safeFailure("STAGING_STORAGE_BUCKET_LOOKUP_FAILED","The staging private bucket could not be inspected.",bucketResponse.status);
  let bucketInfo;
  try{bucketInfo=await bucketResponse.json();}catch{throw safeFailure("STAGING_STORAGE_BUCKET_RESPONSE_INVALID","The staging bucket response was invalid.",502);}
  if(bucketInfo?.id!==config.bucket||bucketInfo?.public!==false)
    throw safeFailure("STAGING_STORAGE_BUCKET_NOT_PRIVATE","The configured staging bucket is missing or is not private.",409);

  const assetId=createId();
  if(!UUID.test(assetId))throw new Error("Storage test asset identifier generator returned an invalid UUID.");
  const objectPath=ownerId+"/"+assetId+"/original.txt";
  const encodedPath=objectPath.split("/").map(encodeURIComponent).join("/");
  const objectUrl=config.origin+"/storage/v1/object/"+encodeURIComponent(config.bucket)+"/"+encodedPath;
  const bytes=Buffer.from("Executive Visuals private staging storage acceptance "+String(now())+" "+assetId,"utf8");
  let uploaded=false,cleanupPending=false;
  const expectBytes=async(response,code)=>{
    if(!response.ok)throw safeFailure(code,"A staging private-storage round-trip step failed.",response.status);
    const actual=await readBytes(response);
    if(!bytesEqual(actual,bytes))throw safeFailure("STAGING_STORAGE_CONTENT_MISMATCH","The downloaded staging object did not match the uploaded test bytes.",502);
  };
  try{
    const upload=await fetchImpl(objectUrl,{
      method:"POST",headers:{...serverHeaders,"content-type":"text/plain","cache-control":"no-store","x-upsert":"false"},
      body:bytes,redirect:"error"
    });
    if(!upload.ok)throw safeFailure("STAGING_STORAGE_UPLOAD_FAILED","The temporary staging object could not be uploaded.",upload.status);
    uploaded=true;

    const ownerDownload=await fetchImpl(config.origin+"/storage/v1/object/authenticated/"+encodeURIComponent(config.bucket)+"/"+encodedPath,{
      method:"GET",headers:{apikey:config.anonKey,authorization:"Bearer "+config.ownerJwt},redirect:"error"
    });
    await expectBytes(ownerDownload,"STAGING_STORAGE_OWNER_READ_FAILED");

    const otherDownload=await fetchImpl(config.origin+"/storage/v1/object/authenticated/"+encodeURIComponent(config.bucket)+"/"+encodedPath,{
      method:"GET",headers:{apikey:config.anonKey,authorization:"Bearer "+config.otherJwt},redirect:"error"
    });
    if(otherDownload.ok)throw safeFailure("STAGING_STORAGE_TENANT_ISOLATION_FAILED","A different staging user could read another user's private object.",500);
    if(![401,403,404].includes(otherDownload.status))
      throw safeFailure("STAGING_STORAGE_TENANT_DENIAL_UNEXPECTED","Cross-user storage denial returned an unexpected response.",otherDownload.status);

    const signed=await fetchImpl(config.origin+"/storage/v1/object/sign/"+encodeURIComponent(config.bucket)+"/"+encodedPath,{
      method:"POST",headers:{...serverHeaders,"content-type":"application/json"},body:JSON.stringify({expiresIn:60}),redirect:"error"
    });
    if(!signed.ok)throw safeFailure("STAGING_STORAGE_SIGNED_URL_FAILED","The staging object could not be signed.",signed.status);
    let signedBody;
    try{signedBody=await signed.json();}catch{throw safeFailure("STAGING_STORAGE_SIGNED_URL_INVALID","The staging signed-URL response was invalid.",502);}
    const signedValue=String(signedBody?.signedURL||signedBody?.signedUrl||"");
    if(!signedValue)throw safeFailure("STAGING_STORAGE_SIGNED_URL_INVALID","The staging signed-URL response did not contain a URL.",502);
    const signedUrl=new URL(signedValue,config.origin);
    if(signedUrl.protocol!=="https:"||signedUrl.origin!==config.origin)
      throw safeFailure("STAGING_STORAGE_SIGNED_URL_HOST_INVALID","The staging signed URL escaped the approved project origin.",502);
    const signedDownload=await fetchImpl(signedUrl.toString(),{method:"GET",redirect:"error"});
    await expectBytes(signedDownload,"STAGING_STORAGE_SIGNED_DOWNLOAD_FAILED");

    return {state:"PASSED",projectRef:APPROVED_STAGING_PROJECT_REF,bucket:config.bucket,
      bucketPrivate:true,ownerIdentityVerified:true,otherIdentityVerified:true,
      ownerRead:true,crossTenantReadDenied:true,signedRead:true,temporaryObjectDeleted:false,
      credentialValuesExposed:false};
  } finally {
    if(uploaded){
      try{
        const removed=await fetchImpl(objectUrl,{method:"DELETE",headers:serverHeaders,redirect:"error"});
        if(!removed.ok&&removed.status!==404)cleanupPending=true;
      }catch{cleanupPending=true;}
    }
    if(cleanupPending)throw safeFailure("STAGING_STORAGE_CLEANUP_PENDING","The temporary staging object could not be confirmed deleted. Operator cleanup is required.",500);
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  runPrivateStorageRoundTrip().then(report=>console.log(JSON.stringify(report))).catch(error=>{
    console.log(JSON.stringify({state:"FAILED",code:error?.code||"STAGING_STORAGE_TEST_FAILED",
      missing:error?.missing||undefined,credentialValuesExposed:false}));
    process.exitCode=1;
  });
}
