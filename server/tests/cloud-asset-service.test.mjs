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
