import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoogleGeminiGcsMirrorRecoveryWorker } from "../google-gemini-gcs-mirror-recovery-worker.mjs";

const ownerId="11111111-1111-4111-8111-111111111111";
const projectId="22222222-2222-4222-8222-222222222222";
const assetId="33333333-3333-4333-8333-333333333333";
const attemptId="44444444-4444-4444-8444-444444444444";
const leaseToken="55555555-5555-4555-8555-555555555555";
const bytes=Buffer.from([1,2,3,4]);
const sha256=createHash("sha256").update(bytes).digest("hex");
const sessionUri="https://storage.googleapis.com/upload/storage/v1/b/private-media-bucket/o?uploadType=resumable&upload_id=opaque-session-secret";
const env={GOOGLE_CLOUD_PROJECT_ID:"test-gcp-project-12345",GEMINI_GCS_ALLOWED_BUCKETS:"private-media-bucket"};
const baseAttempt={
  id:attemptId,state:"OUTCOME_UNKNOWN",assetId,ownerId,projectId,
  bucket:"private-media-bucket",objectName:"mirrors/"+ownerId+"/"+projectId+"/"+assetId+"/mirror.mp4",
  mediaType:"video/mp4",sizeBytes:bytes.length,sha256,sessionUri,
  sessionExpiresAt:"2026-11-12T00:00:00.000Z"
};
function objectMetadata(attempt=baseAttempt,overrides={}) {
  return {
    bucket:attempt.bucket,name:attempt.objectName,generation:"1762300800000000",metageneration:"3",
    size:String(attempt.sizeBytes),contentType:attempt.mediaType,
    metadata:{
      executivevisualsassetid:attempt.assetId,executivevisualsownerid:attempt.ownerId,
      executivevisualsprojectid:attempt.projectId,executivevisualssha256:attempt.sha256
    },...overrides
  };
}
async function harness({attempt=baseAttempt,statusCode=200,range=null,uploadCode=200,metadata=objectMetadata(),fetchFailure=null,sourceFailure=null,materializedBytes=bytes}={}) {
  const root=await mkdtemp(join(tmpdir(),"ev-gcs-recovery-"));
  const filePath=join(root,"source.mp4");
  await writeFile(filePath,materializedBytes);
  const calls=[],transitions=[],records=[],releases=[];
  let claimed=false;
  const attemptRepository={
    async listRecoveryAttempts(){return [attempt];},
    async claimRecoveryAttempt(){if(claimed)return null;claimed=true;return leaseToken;},
    async releaseRecoveryAttempt(input){releases.push(input);if(input.leaseToken!==leaseToken)return false;claimed=false;return true;},
    async transition(input){
      transitions.push(input);
      if(input.leaseToken!==leaseToken)throw new Error("lease fence missing");
      if(["REGISTERED","FAILED","QUARANTINED"].includes(input.state))claimed=false;
      return input;
    }
  };
  const sourceRepository={async recordVerifiedSource(input){records.push(input);if(sourceFailure)throw sourceFailure;return {...input,state:"ACTIVE"};}};
  const fetchImpl=async(url,options)=>{
    calls.push({url:String(url),options});
    if(fetchFailure)throw fetchFailure;
    if(String(url)===sessionUri){
      if(options.method==="PUT"&&options.headers["content-range"]==="bytes */4"){
        return new Response(null,{status:statusCode,headers:range?{range}:{}});
      }
      if(options.method==="PUT"){
        const chunks=[];for await(const chunk of options.body)chunks.push(Buffer.from(chunk));
        const offset=range?2:0;
        assert.deepEqual(Buffer.concat(chunks),bytes.subarray(offset));
        assert.equal(options.headers["content-range"],"bytes "+offset+"-3/4");
        assert.equal(options.headers["content-length"],String(4-offset));
        return new Response(null,{status:uploadCode});
      }
    }
    if(options.method==="GET")return new Response(JSON.stringify(metadata),{status:200});
    throw new Error("unexpected GCS request");
  };
  const worker=createGoogleGeminiGcsMirrorRecoveryWorker({
    attemptRepository,sourceRepository,
    loadPrivateAsset:async()=>({path:filePath,size:bytes.length,sha256,cleanup:async()=>{}}),
    getAccessToken:async()=> "oauth-test-access-token-123456",
    fetchImpl,env,now:()=>new Date("2026-11-05T00:00:00.000Z")
  });
  return {root,worker,calls,transitions,records,releases};
}

test("reconciles a session already completed at GCS without resending the object",async()=>{
  const h=await harness();
  try{
    const result=await h.worker.run();
    assert.equal(result.registered,1);
    assert.equal(h.records.length,1);
    assert.deepEqual(h.transitions.map(x=>x.state),["OBJECT_VERIFIED","REGISTERED"]);
    assert.equal(h.calls.filter(x=>x.url===sessionUri).length,1);
    assert.equal(h.calls.some(x=>x.url.includes("/storage/v1/b/")),true);
    assert.equal(h.releases.length,0);
  }finally{await rm(h.root,{recursive:true,force:true});}
});

test("resumes only the unpersisted byte range after a 308 status response",async()=>{
  const h=await harness({statusCode:308,range:"bytes=0-1"});
  try{
    const result=await h.worker.run();
    assert.equal(result.registered,1);
    const resume=h.calls.find(x=>x.url===sessionUri&&x.options.headers["content-range"]?.startsWith("bytes 2-"));
    assert.ok(resume);
    assert.deepEqual(h.transitions.map(x=>x.state),["OBJECT_VERIFIED","REGISTERED"]);
    assert.equal(h.records[0].sha256,sha256);
  }finally{await rm(h.root,{recursive:true,force:true});}
});

test("uses an empty status range as offset zero and resumes from the first byte",async()=>{
  const h=await harness({statusCode:308,range:null});
  try{
    const result=await h.worker.run();
    assert.equal(result.registered,1);
    assert.equal(h.calls.some(x=>x.url===sessionUri&&x.options.headers["content-range"]==="bytes 0-3/4"),true);
    assert.equal(h.records.length,1);
  }finally{await rm(h.root,{recursive:true,force:true});}
});

test("recovers an OBJECT_VERIFIED attempt without requiring an active upload session",async()=>{
  const attempt={...baseAttempt,state:"OBJECT_VERIFIED",sessionUri:undefined,sessionExpiresAt:null};
  const h=await harness({attempt});
  try{
    const result=await h.worker.run();
    assert.equal(result.registered,1);
    assert.deepEqual(h.transitions.map(x=>x.state),["REGISTERED"]);
  }finally{await rm(h.root,{recursive:true,force:true});}
});

test("quarantines expired resumable sessions without contacting Google",async()=>{
  const h=await harness({attempt:{...baseAttempt,sessionExpiresAt:"2026-11-01T00:00:00.000Z"}});
  try{
    const result=await h.worker.run();
    assert.equal(result.quarantined,1);
    assert.equal(h.transitions[0].state,"QUARANTINED");
    assert.equal(h.calls.length,0);
  }finally{await rm(h.root,{recursive:true,force:true});}
});

test("quarantines metadata that does not match the immutable asset receipt",async()=>{
  const h=await harness({metadata:objectMetadata(baseAttempt,{size:"999"})});
  try{
    const result=await h.worker.run();
    assert.equal(result.quarantined,1);
    assert.equal(h.records.length,0);
    assert.equal(h.transitions[0].state,"QUARANTINED");
  }finally{await rm(h.root,{recursive:true,force:true});}
});

test("retains retryable state and releases lease after transient network errors",async()=>{
  const h=await harness({fetchFailure:new Error("network interrupted")});
  try{
    const result=await h.worker.run();
    assert.equal(result.retryPending,1);
    assert.equal(h.releases.length,1);
    assert.equal(h.transitions.length,0);
  }finally{await rm(h.root,{recursive:true,force:true});}
});

test("quarantines a private source whose materialized digest differs from the durable receipt",async()=>{
  const h=await harness({statusCode:308,range:"bytes=0-1",materializedBytes:Buffer.from([9,9,9,9])});
  try{
    const result=await h.worker.run();
    assert.equal(result.quarantined,1);
    assert.equal(h.records.length,0);
    assert.equal(h.transitions[0].state,"QUARANTINED");
  }finally{await rm(h.root,{recursive:true,force:true});}
});

test("does not register a verified object when source-registry persistence fails",async()=>{
  const h=await harness({sourceFailure:new Error("registry unavailable")});
  try{
    const result=await h.worker.run();
    assert.equal(result.retryPending,1);
    assert.equal(h.records.length,1);
    assert.equal(h.transitions[0].state,"OBJECT_VERIFIED");
    assert.equal(h.releases.length,1);
  }finally{await rm(h.root,{recursive:true,force:true});}
});

test("quarantines invalid or out-of-bounds server ranges",async()=>{
  const h=await harness({statusCode:308,range:"bytes=0-400"});
  try{
    const result=await h.worker.run();
    assert.equal(result.retryPending,1);
    assert.equal(h.records.length,0);
    assert.equal(h.releases.length,1);
  }finally{await rm(h.root,{recursive:true,force:true});}
});
