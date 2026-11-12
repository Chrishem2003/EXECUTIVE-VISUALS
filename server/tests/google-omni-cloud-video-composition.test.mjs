import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { createGoogleOmniCloudVideoComposition } from "../google-omni-cloud-video-composition.mjs";

const ownerId="123e4567-e89b-42d3-a456-426614174000";
const projectId="223e4567-e89b-42d3-a456-426614174000";
const jobId="323e4567-e89b-42d3-a456-426614174000";
const leaseToken="923e4567-e89b-42d3-a456-426614174000";
const interactionId="v1_abcdef123456";
const requestHash="a".repeat(64);
const bytes=Buffer.from("verified-private-google-video-output");
const outputUri="https://generativelanguage.googleapis.com/v1beta/files/generated-video:download?alt=media";
const job={id:jobId,owner_id:ownerId,project_id:projectId,job_type:"video.generate",lease_owner:"google-worker-1",lease_token:leaseToken,input:{requestHash}};

function harness({assertLease=async()=>true,existing=null}={}) {
  const calls=[];
  const asset={
    async findVideoGenerationOutput(scope){calls.push(["find",scope]);return existing;},
    async createFromFileIdempotent(value){
      calls.push(["publish",value]);
      await value.assertLease();
      const actual=await readFile(value.filePath);
      assert.deepEqual(actual,bytes);
      return {id:"423e4567-e89b-42d3-a456-426614174000",ownerId,projectId,mediaType:"video/mp4",size:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),storageBucket:"executive-visuals-media"};
    }
  };
  const interactions={
    async findInteraction(scope){
      calls.push(["authorize",scope]);
      return {provider:"google",model:"gemini-omni-1.1-flash",interactionId,ownerId,projectId,jobId,requestHash,state:"succeeded"};
    },
    async recordInteraction(value){calls.push(["record",value]);return value;},
    async updateInteraction(value){calls.push(["update",value]);return value;}
  };
  const composition=createGoogleOmniCloudVideoComposition({
    assets:asset,
    interactions,
    client:{
      async createInteraction(){return {interactionId,provider:"google",model:"gemini-omni-1.1-flash",status:"running"};},
      async getInteractionForIngestion(){return null;}
    },
    preparePlan:async()=>({policy:{provider:"google",model:"gemini-omni-1.1-flash",requiresApproval:true},payload:{}}),
    retentionExpiresAt:async()=>new Date(Date.now()+86400000).toISOString(),
    env:{GEMINI_API_KEY:"server-only-test-key"},
    fetchImpl:async url=>{
      calls.push(["fetch",String(url)]);
      if(String(url).includes("/v1beta/files/")&&!String(url).includes(":download")){
        return new Response(JSON.stringify({name:"files/generated-video",state:"ACTIVE"}),{status:200,headers:{"content-type":"application/json"}});
      }
      return new Response(bytes,{status:200,headers:{"content-type":"video/mp4","content-length":String(bytes.length)}});
    },
    timeoutMs:3000,
    fileReadyTimeoutMs:1000,
    filePollIntervalMs:10
  });
  return {composition,calls,assertLease};
}

const raw={id:interactionId,model:"gemini-omni-1.1-flash",status:"completed",steps:[{
  type:"model_output",content:[{type:"video",mime_type:"video/mp4",uri:outputUri}]
}]};
const context={ownerId,projectId,jobId,requestHash,workerId:job.lease_owner,leaseToken,assertLease:async()=>true};

test("Google Omni output uses the existing fenced private asset repository",async()=>{
  const h=harness();
  const result=await h.composition.outputIngestor.ingestInteraction(raw,{...context,assertLease:h.assertLease});
  assert.equal(result.assetId,"423e4567-e89b-42d3-a456-426614174000");
  assert.equal(result.ownerId,ownerId);
  assert.equal(result.projectId,projectId);
  assert.equal(result.sha256,createHash("sha256").update(bytes).digest("hex"));
  const publication=h.calls.find(call=>call[0]==="publish")[1];
  assert.equal(publication.ownerId,ownerId);
  assert.equal(publication.projectId,projectId);
  assert.equal(publication.publicationKey,"google:"+jobId+":"+interactionId+":output:0");
  assert.equal(publication.leaseContext.jobId,jobId);
  assert.equal(publication.leaseContext.workerId,job.lease_owner);
  assert.equal(publication.leaseContext.leaseToken,leaseToken);
  assert.equal(typeof publication.assertLease,"function");
  await assert.rejects(()=>access(publication.filePath));
});

test("Google Omni output refuses publication after the worker lease is lost",async()=>{
  const h=harness({assertLease:async()=>false});
  await assert.rejects(()=>h.composition.outputIngestor.ingestInteraction(raw,{...context,assertLease:h.assertLease}),error=>
    error.code==="GEMINI_OMNI_OUTPUT_INGEST_FAILED");
  assert.equal(h.calls.some(call=>call[0]==="publish"),false);
});
