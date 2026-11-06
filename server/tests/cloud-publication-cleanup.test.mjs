import test from "node:test";
import assert from "node:assert/strict";
import { createCloudPublicationCleanup } from "../cloud-publication-cleanup.mjs";

const ownerId="123e4567-e89b-42d3-a456-426614174000";
const assetId="323e4567-e89b-42d3-a456-426614174000";
const activeAttempt="attempt-423e4567-e89b-42d3-a456-426614174000.mp4";
const orphanAttempt="attempt-523e4567-e89b-42d3-a456-426614174000.mp4";
const prefix=ownerId+"/"+assetId+"/";
const now=new Date("2026-11-06T12:00:00.000Z");
const old="2026-11-04T00:00:00.000Z";
function fixture({referenced=[],active=false,leaseCheck=true,removeError=false}={}) {
 const removed=[],events=[];
 const entries=[
  {name:activeAttempt,createdAt:old},
  {name:orphanAttempt,createdAt:old},
  {name:"original.mp4",createdAt:old},
  {name:"attempt-623e4567-e89b-42d3-a456-426614174000.mp4",createdAt:"2026-11-06T11:30:00.000Z"},
  {name:"attempt-723e4567-e89b-42d3-a456-426614174000.mp4",createdAt:null}
 ];
 const storage={
  async listObjects(args){assert.deepEqual(args,{prefix,limit:100,offset:0});return entries;},
  async remove(path){if(removeError)throw new Error("storage unavailable");removed.push(path);return true;}
 };
 const cleanup=createCloudPublicationCleanup({
  storage,
  findReferencedPaths:async paths=>paths.filter(path=>referenced.includes(path)),
  ...(leaseCheck?{isAttemptActive:async()=>active}:{}),
  onEvent:async event=>events.push(event),
  now:()=>now
 });
 return {cleanup,removed,events};
}

test("defaults to a dry-run and reports only old unreferenced inactive attempt objects",async()=>{
 const f=fixture({active:false});
 const result=await f.cleanup.run({prefix});
 assert.equal(result.dryRun,true);
 assert.equal(result.candidateCount,2);
 assert.equal(result.eligibleCount,2);
 assert.equal(result.removedCount,0);
 assert.equal(f.removed.length,0);
 assert.ok(result.eligible.every(item=>item.objectPath.startsWith(prefix+"attempt-")));
 assert.ok(result.skipped.some(item=>item.reason==="created_at_unavailable"));
 assert.ok(result.skipped.some(item=>item.reason==="lease_state_unavailable")===false);
});

test("never deletes referenced or actively leased attempt objects",async()=>{
 const f=fixture({referenced:[prefix+activeAttempt],active:true});
 const result=await f.cleanup.run({prefix,dryRun:false,confirmDelete:true});
 assert.equal(result.removedCount,0);
 assert.ok(result.skipped.some(item=>item.reason==="asset_reference_exists"));
 assert.ok(result.skipped.some(item=>item.reason==="active_worker_lease"));
 assert.equal(f.removed.length,0);
});

test("requires explicit destructive confirmation and a lease checker",async()=>{
 const noLease=fixture({leaseCheck:false});
 await assert.rejects(()=>noLease.cleanup.run({prefix,dryRun:false,confirmDelete:true}),/lease check/);
 const noConfirm=fixture();
 await assert.rejects(()=>noConfirm.cleanup.run({prefix,dryRun:false}),/explicit confirmation/);
});

test("deletes only verified orphan attempt paths and emits audit events",async()=>{
 const f=fixture({active:false});
 const result=await f.cleanup.run({prefix,dryRun:false,confirmDelete:true});
 assert.equal(result.removedCount,2);
 assert.deepEqual(f.removed,result.removed.map(item=>item.objectPath));
 assert.ok(f.removed.every(path=>/^.+\\/attempt-[0-9a-f-]{36}\\.[A-Za-z0-9]+$/i.test(path)));
 assert.ok(f.events.some(event=>event.type==="publication.orphan_removed"));
 assert.ok(f.events.some(event=>event.type==="publication.cleanup_completed"&&event.removedCount===2));
});

test("fails closed when reference lookup fails or cleanup deletion fails",async()=>{
 const f=fixture({removeError:true});
 const failedLookup=createCloudPublicationCleanup({
  storage:{listObjects:async()=>[{name:orphanAttempt,createdAt:old}],remove:async()=>true},
  findReferencedPaths:async()=>{throw new Error("database unavailable");},
  isAttemptActive:async()=>false,
  now:()=>now
 });
 await assert.rejects(()=>failedLookup.run({prefix}),/reference lookup/);
 const result=await f.cleanup.run({prefix,dryRun:false,confirmDelete:true});
 assert.equal(result.removedCount,0);
 assert.ok(result.skipped.some(item=>item.reason==="storage_remove_failed"));
});

test("rejects unsafe prefixes, age thresholds and unbounded batches",async()=>{
 const f=fixture();
 await assert.rejects(()=>f.cleanup.run({prefix:"../"}),/exactly an owner-or-project/);
 await assert.rejects(()=>f.cleanup.run({prefix,olderThanMs:1000}),/24 hours/);
 await assert.rejects(()=>f.cleanup.run({prefix,limit:101}),/between 1 and 100/);
});
