import test from "node:test";
import assert from "node:assert/strict";
import {createCloudTransformationAuthorization} from "../cloud-transformation-authorization.mjs";

const ownerId="11111111-1111-4111-8111-111111111111";
const projectId="22222222-2222-4222-8222-222222222222";
const approvalId="33333333-3333-4333-8333-333333333333";
const approverId="44444444-4444-4444-8444-444444444444";
const row={id:"55555555-5555-4555-8555-555555555555",owner_id:ownerId,project_id:projectId,job_type:"video.transform.plan",status:"awaiting_approval",approved_by:approverId,approved_at:"2026-11-02T10:00:00Z",estimated_cost:{approvalId,adapterId:"adapter-a",capability:"video.transform",approvedBudgetMicros:2500000}};

function make(fetchImpl){
 return createCloudTransformationAuthorization({url:"https://example.supabase.co",serviceRoleKey:"server-only-test-key",fetchImpl,ownerId,projectId});
}
const request={approvalId,pipelineId:"pipe-1",stepId:"step-1",adapterId:"adapter-a",capability:"video.transform",requiredBudgetMicros:2000000};

test("live authorization accepts the exact active approval and covering budget",async()=>{
 let urlSeen="";
 const authorize=make(async(url,options)=>{urlSeen=url;assert.equal(options.headers.authorization,"Bearer server-only-test-key");return{ok:true,json:async()=>[row]};});
 assert.deepEqual(await authorize(request),{approved:true,approvalId,adapterId:"adapter-a",capability:"video.transform",approvedBudgetMicros:2500000});
 assert.match(decodeURIComponent(urlSeen),/estimated_cost->>approvalId=eq\./);
});

test("live authorization rejects revoked or mismatched approval records",async()=>{
 for(const changed of [
  {...row,status:"cancelled"},
  {...row,estimated_cost:{...row.estimated_cost,adapterId:"other"}},
  {...row,estimated_cost:{...row.estimated_cost,capability:"other"}},
  {...row,estimated_cost:{...row.estimated_cost,approvedBudgetMicros:100}},
  {...row,approved_at:null}
 ]){
  const authorize=make(async()=>({ok:true,json:async()=>[changed]}));
  assert.equal((await authorize(request)).approved,false);
 }
});

test("live authorization fails closed on database errors and malformed responses",async()=>{
 assert.equal((await make(async()=>({ok:false})) (request)).approved,false);
 assert.equal((await make(async()=>({ok:true,json:async()=>"not-an-array"}))(request)).approved,false);
 assert.equal((await make(async()=>{throw new Error("offline");})(request)).approved,false);
});

test("live authorization refuses malformed IDs and respects cancellation",async()=>{
 let calls=0;
 const authorize=make(async()=>{calls++;return{ok:true,json:async()=>[row]};});
 assert.equal((await authorize({...request,approvalId:"bad"})).approved,false);
 const controller=new AbortController();controller.abort();
 assert.equal((await authorize({...request,signal:controller.signal})).approved,false);
 assert.equal(calls,0);
});
