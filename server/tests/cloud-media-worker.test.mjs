import test from "node:test";
import assert from "node:assert/strict";
import { createCloudMediaWorker } from "../cloud-media-worker.mjs";

test("cloud media worker composes the leased queue and injected media executor", async () => {
  const calls = [];
  let claimedTypes;
  const queue = {
    async claim(workerId, leaseSeconds, jobTypes) { calls.push("claim"); claimedTypes = jobTypes; return null; },
    async renew() { return true; },
    async assertLease() { return true; },
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
  assert.deepEqual(claimedTypes, ["media.probe", "media.thumbnail", "media.audio_extract", "media.audio-clean", "media.denoise", "media.color", "media.resize", "media.interpolate", "media.upscale", "media.ai-upscale", "media.video-ai-upscale", "media.transcode", "media.proxy"]);
  assert.equal(await worker.recoverExpired(25), 2);
  assert.deepEqual(calls, ["claim", "recover:25"]);
});

test("cloud media worker requires an explicit stable worker identity", () => {
  assert.throws(
    () => createCloudMediaWorker({ workerId: " " }),
    /worker ID/
  );
});

test("cloud media worker forwards owner cancellation to the generic worker",async()=>{
 const calls=[];const queue={
  async claim(){return{id:"media-job",lease_token:"11111111-1111-4111-8111-111111111111"};},
  async cancellationRequested(){calls.push("cancel-check");return true;},
  async renew(){return true;},async assertLease(){return true;},
  async finish(id,worker,status,output,error){calls.push(status);return true;},async recover(){return 0;}
 };
 let executed=false;
 const worker=createCloudMediaWorker({workerId:"media-worker-cancel",queue,assetService:{assets:{}},mediaIO:{},execute:async()=>{executed=true;return{};}});
 const result=await worker.runCycle();
 assert.equal(result.status,"cancelled");assert.equal(executed,false);assert.deepEqual(calls,["cancel-check","cancelled"]);
});
