import test from "node:test";
import assert from "node:assert/strict";
import { createCloudAssetService } from "../cloud-asset-service.mjs";

test("composes private storage, fail-closed authorization and metadata repository",()=>{
 const calls=[];
 const storage={upload:async()=>({bucket:"executive-visuals-media",path:"x",size:1}),remove:async()=>true,createSignedUrl:async()=>"https://example.supabase.co/signed"};
 const service=createCloudAssetService({
  url:"https://example.supabase.co",serviceRoleKey:"private",
  storage,authorize:async()=>true,
  fetchImpl:async(url,options)=>{calls.push({url,options});return{ok:true,async text(){return"[]";}};}
 });
 assert.equal(typeof service.assets.create,"function");
 assert.equal(typeof service.assets.createSignedUrl,"function");
 assert.equal(service.storage,storage);
});
test("factory requires valid credentials even when adapters are injected",()=>{
 assert.throws(()=>createCloudAssetService({storage:{},authorize:async()=>true}),/credentials/);
});

test("R2 asset composition rejects a custom bucket while metadata and cleanup contracts pin the canonical bucket",()=>{
 const base={
  url:"https://example.supabase.co",serviceRoleKey:"private",
  storageProvider:"r2",
  r2:{accountId:"0123456789abcdef0123456789abcdef",accessKeyId:"0123456789abcdef",secretAccessKey:"s".repeat(40)},
  fetchImpl:async()=>{throw new Error("metadata network must not run during composition");}
 };
 const service=createCloudAssetService(base);
 assert.equal(service.storage.bucket,"executive-visuals-media");
 assert.equal(createCloudAssetService({...base,r2:{...base.r2,bucket:""}}).storage.bucket,"executive-visuals-media");
 assert.throws(()=>createCloudAssetService({...base,r2:{...base.r2,bucket:"custom-media-bucket"}}),/R2_BUCKET must be executive-visuals-media/);
});

test("composes Neon Object Storage without provisioning or changing the configured bucket",()=>{
 const base={
  url:"https://example.supabase.co",serviceRoleKey:"private",
  storageProvider:"neon",
  neon:{
   endpoint:"https://br-staging.storage.c-9.us-east-2.aws.neon.tech",
   region:"us-east-2",accessKeyId:"neon_test_key_123",
   secretAccessKey:"s".repeat(40),bucket:"executive-visuals-media"
  },
  fetchImpl:async()=>{throw new Error("metadata network must not run during composition");}
 };
 const service=createCloudAssetService(base);
 assert.equal(service.storage.bucket,"executive-visuals-media");
 assert.equal(service.storage.endpoint,base.neon.endpoint);
 assert.throws(()=>createCloudAssetService({...base,neon:{...base.neon,bucket:"custom-media"} }),/NEON_STORAGE_BUCKET/);
});

test("Cloud Timeline Service passes explicit Neon branch credentials into its private storage adapter", async () => {
 const { createCloudTimelineService } = await import("../cloud-timeline-service.mjs");
 const neon={
  endpoint:"https://br-staging.storage.c-9.us-east-2.aws.neon.tech",
  region:"us-east-2",accessKeyId:"neon_test_key_123",
  secretAccessKey:"s".repeat(40),bucket:"executive-visuals-media"
 };
 const service=createCloudTimelineService({
  url:"https://example.supabase.co",serviceRoleKey:"private",
  storageProvider:"neon",neon,
  fetchImpl:async()=>{throw new Error("metadata network must not run during composition");}
 });
 assert.equal(service.storage.endpoint,neon.endpoint);
 assert.equal(service.storage.bucket,"executive-visuals-media");
});
