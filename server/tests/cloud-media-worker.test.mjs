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

test("cloud media worker exposes explicit tombstone cleanup without scheduling it",async()=>{
  const calls=[];
  const result={scanned:2,removed:1,pending:1,skippedInvalid:0};
  const worker=createCloudMediaWorker({
    workerId:"media-maintenance-worker",
    queue:{async claim(){return null;},async renew(){return true;},async finish(){return true;},async recover(){return 0;}},
    assetService:{assets:{async cleanupDeleted(options){calls.push(options);return result;}}},
    mediaIO:{},
    execute:async()=>({ok:true})
  });
  assert.deepEqual(await worker.cleanupDeletedAssets({olderThan:"2026-11-01T00:00:00.000Z",limit:10}),result);
  assert.deepEqual(calls,[{olderThan:"2026-11-01T00:00:00.000Z",limit:10}]);
});

test("cloud media worker fails closed when tombstone cleanup is not supported",async()=>{
  const worker=createCloudMediaWorker({
    workerId:"media-worker-no-cleanup",
    queue:{async claim(){return null;},async renew(){return true;},async finish(){return true;},async recover(){return 0;}},
    assetService:{assets:{}},
    mediaIO:{},
    execute:async()=>({ok:true})
  });
  await assert.rejects(()=>worker.cleanupDeletedAssets({olderThan:"2026-11-01T00:00:00.000Z"}),/does not support tombstone cleanup/);
});
