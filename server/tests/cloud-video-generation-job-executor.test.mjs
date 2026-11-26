import test from "node:test";
import assert from "node:assert/strict";
import {executeCloudVideoGenerationJob} from "../cloud-video-generation-job-executor.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const project="223e4567-e89b-42d3-a456-426614174000";
const job={
 id:"323e4567-e89b-42d3-a456-426614174000",owner_id:owner,project_id:project,
 job_type:"video.generate",lease_token:"423e4567-e89b-42d3-a456-426614174000",
 input:{provider:"fal",model:"test-model",requestHash:"a".repeat(64)},
 estimated_cost:{amount:5,currency:"USD"}
};
function fixture({authorizeSubscription,requireSubscription=true}={}){
 const calls=[];
 const ledger={
  async prepare(){calls.push("prepare");return {state:"prepared",provider_task_id:null,metadata:{}};},
  async begin(){calls.push("begin");return true;},
  async record(){calls.push("record");return true;},
  async markUnknown(){calls.push("markUnknown");return true;}
 };
 const adapter={
  provider:"fal",model:"test-model",
  async submit(){calls.push("submit");throw Object.assign(new Error("provider timeout"),{code:"TEST_PROVIDER_TIMEOUT"});},
  async getStatus(){throw new Error("poll should not be reached");}
 };
 const run=()=>executeCloudVideoGenerationJob({
  job,workerId:"worker-test",ledger,adapter,
  ingestOutputs:async()=>({assetIds:[]}),
  resolveActualCost:async()=>({amount:1,currency:"USD",evidenceReference:"test:actual-cost"}),
  authorizeSubscription,requireSubscription,assertLease:async()=>true
 });
 return {calls,run};
}

test("hosted video worker checks subscription before the durable provider-submission transition",async()=>{
 const f=fixture({authorizeSubscription:async()=>({active:true,entitlements:{features:{videoGeneration:true}}})});
 await assert.rejects(f.run(),{code:"VIDEO_SUBMISSION_REQUIRES_RECONCILIATION"});
 assert.ok(f.calls.includes("prepare"));
 assert.ok(f.calls.includes("begin"));
 assert.ok(f.calls.includes("submit"));
});

test("hosted video worker blocks expired or missing subscriptions before provider submission",async()=>{
 const f=fixture({authorizeSubscription:async()=>({active:false,reason:"An active subscription is required."})});
 await assert.rejects(f.run(),{code:"SUBSCRIPTION_ENTITLEMENT_REQUIRED"});
 assert.ok(f.calls.includes("prepare"));
 assert.equal(f.calls.includes("begin"),false);
 assert.equal(f.calls.includes("submit"),false);
});

test("hosted video worker defers provider submission when subscription verification is unavailable",async()=>{
 const f=fixture({authorizeSubscription:async()=>{throw Object.assign(new Error("database unavailable"),{code:"SUBSCRIPTION_ENTITLEMENT_LOOKUP_UNAVAILABLE",status:503});}});
 await assert.rejects(f.run(),error=>error.code==="VIDEO_SUBSCRIPTION_CHECK_RETRYABLE"&&error.retryAfterSeconds===60);
 assert.equal(f.calls.includes("begin"),false);
 assert.equal(f.calls.includes("submit"),false);
});

test("hosted video worker quarantines ambiguous multiple-subscription identity",async()=>{
 const f=fixture({authorizeSubscription:async()=>{throw Object.assign(new Error("ambiguous"),{code:"SUBSCRIPTION_RECORD_AMBIGUOUS",status:409});}});
 await assert.rejects(f.run(),{code:"SUBSCRIPTION_RECORD_AMBIGUOUS"});
 assert.equal(f.calls.includes("begin"),false);
 assert.equal(f.calls.includes("submit"),false);
});

test("hosted video worker cannot enable subscription enforcement without a trusted reader",async()=>{
 const f=fixture({authorizeSubscription:null});
 await assert.rejects(f.run(),{code:"SUBSCRIPTION_ENTITLEMENT_LOOKUP_UNAVAILABLE"});
 assert.deepEqual(f.calls,[]);
});
