import test from "node:test";
import assert from "node:assert/strict";
import {createCloudWorkerHeartbeat} from "../cloud-worker-heartbeat.mjs";
test("persists healthy and degraded worker liveness without secrets",async()=>{
 const calls=[];const heartbeat=createCloudWorkerHeartbeat({rpc:async(name,args)=>{calls.push({name,args});return {status:args.p_status};},workerId:"worker-123",workerFamilies:["media","storage_maintenance"]});
 await heartbeat.record({status:"healthy",lastCycleAt:"2026-11-26T00:00:00.000Z"});
 await heartbeat.record({status:"degraded",lastErrorCode:"QUEUE_RENEW_FAILED"});
 assert.equal(calls.length,2);assert.equal(calls[0].name,"record_cloud_worker_heartbeat");
 assert.deepEqual(calls[0].args.p_worker_families,["media","storage_maintenance"]);
 assert.equal("secret" in calls[0].args,false);
});
test("rejects invalid family, status, timestamp and error code",async()=>{
 const heartbeat=createCloudWorkerHeartbeat({rpc:async()=>({}),workerId:"worker-123",workerFamilies:["video"]});
 await assert.rejects(()=>heartbeat.record({status:"unknown"}),/status/);
 await assert.rejects(()=>heartbeat.record({status:"healthy",lastCycleAt:"not-a-date"}),/timestamp/);
 await assert.rejects(()=>heartbeat.record({status:"degraded",lastErrorCode:"Bearer secret"}),/error code/);
 assert.throws(()=>createCloudWorkerHeartbeat({rpc:async()=>({}),workerId:"worker-123",workerFamilies:["video","video"]}),/families/);
});
test("disabled heartbeat does not call database",async()=>{
 const heartbeat=createCloudWorkerHeartbeat({enabled:false,rpc:async()=>{throw new Error("must not call");}});
 assert.deepEqual(await heartbeat.record(),{recorded:false,reason:"worker_heartbeat_disabled"});
});
