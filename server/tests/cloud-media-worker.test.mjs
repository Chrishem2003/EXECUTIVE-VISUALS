import test from "node:test";
import assert from "node:assert/strict";
import { createCloudMediaWorker } from "../cloud-media-worker.mjs";

test("cloud media worker composes the leased queue and injected media executor", async () => {
  const calls = [];
  let claimedTypes;
  const queue = {
    async claim(workerId, leaseSeconds, jobTypes) { calls.push("claim"); claimedTypes = jobTypes; return null; },
    async renew() { return true; },
    async finish() { return true; },
    async recover(limit) { calls.push("recover:" + limit); return 2; }
  };
  const worker = createCloudMediaWorker({
    workerId: "media-worker-a",
    queue,
    assetService: { assets: {} },
    mediaIO: {},
    execute: async () => ({ ok: true })
  });
  assert.deepEqual(await worker.runCycle({ onEvent: event => calls.push(event.type) }), { claimed: false });
  assert.deepEqual(claimedTypes, ["media.probe", "media.thumbnail", "media.audio_extract", "media.audio-clean", "media.denoise", "media.color", "media.resize", "media.interpolate", "media.upscale", "media.ai-upscale", "media.transcode", "media.proxy"]);
  assert.equal(await worker.recoverExpired(25), 2);
  assert.deepEqual(calls, ["claim", "recover:25"]);
});

test("cloud media worker requires an explicit stable worker identity", () => {
  assert.throws(
    () => createCloudMediaWorker({ workerId: " " }),
    /worker ID/
  );
});

test("cloud media worker persists completed probe metadata to its source asset",async()=>{
 const job={id:"job-probe",owner_id:"123e4567-e89b-42d3-a456-426614174000",project_id:"223e4567-e89b-42d3-a456-426614174000",job_type:"media.probe",input:{sourceAssetId:"323e4567-e89b-42d3-a456-426614174000"}};
 const calls=[];let claimed=false;
 const queue={
  async claim(){if(claimed)return null;claimed=true;return job;},
  async renew(){return true;},
  async finish(id,workerId,status,output,error){calls.push({id,workerId,status,output,error});return true;},
  async recover(){return 0;}
 };
 const worker=createCloudMediaWorker({
  workerId:"media-worker-probe",queue,
  assetService:{assets:{async updateMetadata(input){calls.push({metadataUpdate:input});return{id:job.input.sourceAssetId};}}},
  mediaIO:{},
  execute:async()=>({sourceAssetId:job.input.sourceAssetId,metadata:{signalAnalysis:{audioActivity:{status:"completed"}}}})
 });
 const result=await worker.runCycle({heartbeatIntervalMs:1000});
 assert.equal(result.status,"succeeded");
 assert.deepEqual(calls[0],{metadataUpdate:{ownerId:job.owner_id,assetId:job.input.sourceAssetId,patch:{probe:{signalAnalysis:{audioActivity:{status:"completed"}}}}}});
 assert.equal(calls[1].status,"succeeded");
});


test("cloud media probe fails closed when source metadata cannot be persisted",async()=>{
 const job={id:"job-probe-no-persistence",owner_id:"123e4567-e89b-42d3-a456-426614174000",project_id:"223e4567-e89b-42d3-a456-426614174000",job_type:"media.probe",input:{sourceAssetId:"323e4567-e89b-42d3-a456-426614174000"}};
 const calls=[];let claimed=false;
 const queue={
  async claim(){if(claimed)return null;claimed=true;return job;},
  async renew(){return true;},
  async finish(id,workerId,status,output,error){calls.push({status,output,error});return true;},
  async recover(){return 0;}
 };
 const worker=createCloudMediaWorker({workerId:"media-worker-probe-no-persistence",queue,assetService:{assets:{}},mediaIO:{},execute:async()=>({metadata:{signalAnalysis:{audioActivity:{status:"completed"}}}})});
 const result=await worker.runCycle({heartbeatIntervalMs:1000});
 assert.equal(result.status,"failed");
 assert.equal(result.error.code,"CLOUD_MEDIA_PROBE_PERSISTENCE_UNAVAILABLE");
 assert.equal(calls[0].status,"failed");
});

test("cloud media probe fails closed when executor omits metadata",async()=>{
 const job={id:"job-probe-no-metadata",owner_id:"123e4567-e89b-42d3-a456-426614174000",project_id:"223e4567-e89b-42d3-a456-426614174000",job_type:"media.probe",input:{sourceAssetId:"323e4567-e89b-42d3-a456-426614174000"}};
 const calls=[];let claimed=false;
 const queue={
  async claim(){if(claimed)return null;claimed=true;return job;},
  async renew(){return true;},
  async finish(id,workerId,status,output,error){calls.push({status,output,error});return true;},
  async recover(){return 0;}
 };
 const worker=createCloudMediaWorker({workerId:"media-worker-probe-no-metadata",queue,assetService:{assets:{async updateMetadata(){throw new Error("Must not write without metadata.");}}},mediaIO:{},execute:async()=>({sourceAssetId:job.input.sourceAssetId})});
 const result=await worker.runCycle({heartbeatIntervalMs:1000});
 assert.equal(result.status,"failed");
 assert.equal(result.error.code,"CLOUD_MEDIA_PROBE_METADATA_MISSING");
 assert.equal(calls[0].status,"failed");
});
