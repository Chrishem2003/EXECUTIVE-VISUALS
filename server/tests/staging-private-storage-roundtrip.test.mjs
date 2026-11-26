import test from "node:test";
import assert from "node:assert/strict";
import {runPrivateStorageRoundTrip,APPROVED_STAGING_PROJECT_REF} from "../../scripts/verify-staging-private-storage-roundtrip.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const other="223e4567-e89b-42d3-a456-426614174000";
const asset="323e4567-e89b-42d3-a456-426614174000";
const env={
  SUPABASE_STAGING_URL:`https://${APPROVED_STAGING_PROJECT_REF}.supabase.co`,
  SUPABASE_STAGING_ANON_KEY:"test-anon-placeholder",
  SUPABASE_STAGING_SECRET_KEY:"sb_secret_test-placeholder",
  STORAGE_TEST_OWNER_JWT:"owner-jwt-placeholder",
  STORAGE_TEST_OTHER_JWT:"other-jwt-placeholder",
  STORAGE_TEST_OWNER_ID:owner
};
const body=Buffer.from("private test bytes");
function fixture({bucketPublic=false,otherCanRead=false,ownerCanRead=true,signedHost=null,cleanupFails=false}={}){
  const calls=[],objects=new Map();
  const fetchImpl=async(url,options={})=>{
    const target=new URL(url);calls.push({url:target.toString(),method:options.method,headers:options.headers});
    if(target.pathname==="/auth/v1/user")return Response.json({id:options.headers.authorization.endsWith("owner-jwt-placeholder")?owner:other});
    if(target.pathname==="/storage/v1/bucket/executive-visuals-media")return Response.json({id:"executive-visuals-media",public:bucketPublic});
    if(target.pathname.startsWith("/storage/v1/object/executive-visuals-media/")&&options.method==="POST"){
      objects.set(target.pathname,Buffer.from(options.body));return new Response(null,{status:200});
    }
    if(target.pathname.startsWith("/storage/v1/object/authenticated/executive-visuals-media/")){
      const isOwner=options.headers.authorization.endsWith("owner-jwt-placeholder");
      if(!isOwner&&otherCanRead)return new Response(objects.values().next().value||body,{status:200});
      if(!isOwner||!ownerCanRead)return new Response(null,{status:403});
      return new Response(objects.values().next().value||body,{status:200});
    }
    if(target.pathname.startsWith("/storage/v1/object/sign/executive-visuals-media/")&&options.method==="POST"){
      return Response.json({signedURL:signedHost||"/storage/v1/object/sign/executive-visuals-media/temporary?token=opaque"});
    }
    if(target.pathname.startsWith("/storage/v1/object/sign/executive-visuals-media/")&&options.method==="GET"){
      return new Response(objects.values().next().value||body,{status:200});
    }
    if(target.pathname.includes("/storage/v1/object/sign/")&&options.method==="GET"){
      return new Response(objects.values().next().value||body,{status:200});
    }
    if(target.pathname.startsWith("/storage/v1/object/executive-visuals-media/")&&options.method==="DELETE"){
      if(cleanupFails)return new Response(null,{status:500});
      objects.delete(target.pathname);return new Response(null,{status:200});
    }
    throw new Error("Unexpected staging storage request: "+target.pathname+" "+options.method);
  };
  return {fetchImpl,calls,objects};
}

test("private staging round-trip verifies private bucket, owner read, cross-tenant denial, signed read and cleanup",async()=>{
  const f=fixture();
  const result=await runPrivateStorageRoundTrip({env,fetchImpl:f.fetchImpl,createId:()=>asset,now:()=>123});
  assert.equal(result.state,"PASSED");
  assert.equal(result.bucketPrivate,true);
  assert.equal(result.crossTenantReadDenied,true);
  assert.equal(result.signedRead,true);
  assert.ok(f.calls.some(x=>x.method==="DELETE"));
  assert.equal(f.objects.size,0);
  assert.equal(result.credentialValuesExposed,false);
});

test("refuses a public bucket before creating a temporary object",async()=>{
  const f=fixture({bucketPublic:true});
  await assert.rejects(()=>runPrivateStorageRoundTrip({env,fetchImpl:f.fetchImpl,createId:()=>asset}),{code:"STAGING_STORAGE_BUCKET_NOT_PRIVATE"});
  assert.equal(f.calls.some(x=>x.method==="POST"&&x.url.includes("/storage/v1/object/executive-visuals-media/")),false);
});

test("fails when a second user can read the owner's temporary object",async()=>{
  const f=fixture({otherCanRead:true});
  await assert.rejects(()=>runPrivateStorageRoundTrip({env,fetchImpl:f.fetchImpl,createId:()=>asset}),{code:"STAGING_STORAGE_TENANT_ISOLATION_FAILED"});
  assert.ok(f.calls.some(x=>x.method==="DELETE"));
});

test("rejects a signed URL that escapes the approved staging project origin",async()=>{
  const f=fixture({signedHost:"https://attacker.example/private"});
  await assert.rejects(()=>runPrivateStorageRoundTrip({env,fetchImpl:f.fetchImpl,createId:()=>asset}),{code:"STAGING_STORAGE_SIGNED_URL_HOST_INVALID"});
  assert.ok(f.calls.some(x=>x.method==="DELETE"));
});

test("verifies JWT identities against Supabase Auth instead of trusting configured UUID text",async()=>{
  const f=fixture();
  await assert.rejects(()=>runPrivateStorageRoundTrip({env:{...env,STORAGE_TEST_OWNER_ID:other},fetchImpl:f.fetchImpl}),{code:"STAGING_STORAGE_TEST_IDENTITY_MISMATCH"});
  assert.equal(f.calls.some(x=>x.url.includes("/storage/v1/object/")),false);
});

test("reports cleanup failure instead of claiming a successful round-trip",async()=>{
  const f=fixture({cleanupFails:true});
  await assert.rejects(()=>runPrivateStorageRoundTrip({env,fetchImpl:f.fetchImpl,createId:()=>asset}),{code:"STAGING_STORAGE_CLEANUP_PENDING"});
});
