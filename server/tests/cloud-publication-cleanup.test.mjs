import test from "node:test";
import assert from "node:assert/strict";
import { createCloudPublicationCleanup } from "../cloud-publication-cleanup.mjs";

const ownerId="123e4567-e89b-42d3-a456-426614174000";
const assetId="323e4567-e89b-42d3-a456-426614174000";
const activeAttempt="attempt-423e4567-e89b-42d3-a456-426614174000.mp4";
const orphanAttempt="attempt-523e4567-e89b-42d3-a456-426614174000.mp4";
const prefix=ownerId+"/"+assetId+"/";
const cleanupIdentity={jobId:"723e4567-e89b-42d3-a456-426614174000",ownerId,projectId:null,publicationKey:"integration:cleanup-test"};
const now=new Date("2026-11-06T12:00:00.000Z");
const old="2026-11-04T00:00:00.000Z";
function fixture({referenced=[],active=false,leaseCheck=true,removeError=false,claimError=false,completeError=false}={}) {
 const removed=[],events=[],claims=[],completed=[];
 const entries=[
  {name:activeAttempt,createdAt:old},
  {name:orphanAttempt,createdAt:old},
  {name:"original.mp4",createdAt:old},
  {name:"attempt-623e4567-e89b-42d3-a456-426614174000.mp4",createdAt:"2026-11-06T11:30:00.000Z"},
  {name:"attempt-723e4567-e89b-42d3-a456-426614174000.mp4",createdAt:null}
 ];
 const storage={
  async listObjects(args){assert.deepEqual(args,{prefix,limit:100,cursor:null});return{objects:entries,hasNext:true,nextCursor:"next-cleanup-page"};},
  async remove(path){if(removeError)throw new Error("storage unavailable");removed.push(path);return true;}
 };
 const cleanup=createCloudPublicationCleanup({
  storage,
  findReferencedPaths:async paths=>paths.filter(path=>referenced.includes(path)),
  ...(leaseCheck?{isAttemptActive:async()=>active}:{}),
  claimCleanup:async input=>{claims.push(input);if(claimError)throw new Error("claim unavailable");return{claimId:"claim-"+claims.length,claimToken:"token-"+claims.length,status:"claimed"};},
  completeCleanup:async claim=>{completed.push(claim);if(completeError)throw new Error("completion unavailable");return true;},
  onEvent:async event=>{events.push(event);return true;},
  now:()=>now
 });
 return {cleanup,removed,events,claims,completed};
}

test("defaults to a dry-run and reports only old unreferenced inactive attempt objects",async()=>{
 const f=fixture({active:false});
 const result=await f.cleanup.run({prefix});
 assert.equal(result.dryRun,true);
 assert.equal(result.hasNext,true);
 assert.equal(result.nextCursor,"next-cleanup-page");
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
 const result=await f.cleanup.run({...cleanupIdentity,prefix,dryRun:false,confirmDelete:true});
 assert.equal(result.removedCount,0);
 assert.ok(result.skipped.some(item=>item.reason==="asset_reference_exists"));
 assert.ok(result.skipped.some(item=>item.reason==="active_worker_lease"));
 assert.equal(f.removed.length,0);
});

test("requires explicit destructive confirmation and a lease checker",async()=>{
 const noLease=fixture({leaseCheck:false});
 await assert.rejects(()=>noLease.cleanup.run({...cleanupIdentity,prefix,dryRun:false,confirmDelete:true}),/lease check/);
 const noConfirm=fixture();
 await assert.rejects(()=>noConfirm.cleanup.run({prefix,dryRun:false}),/explicit confirmation/);
});

test("deletes only verified orphan attempt paths and emits audit events",async()=>{
 const f=fixture({active:false});
 const result=await f.cleanup.run({...cleanupIdentity,prefix,dryRun:false,confirmDelete:true});
 assert.equal(result.removedCount,2);
 assert.equal(f.claims.length,2);
 assert.equal(f.completed.length,2);
 assert.deepEqual(f.removed,result.removed.map(item=>item.objectPath));
 assert.ok(f.removed.every(path=>/^.+\/attempt-[0-9a-f-]{36}\.[A-Za-z0-9]+$/i.test(path)));
 assert.ok(f.events.some(event=>event.type==="publication.orphan_removed"));
 assert.ok(f.events.some(event=>event.type==="publication.cleanup_completed"&&event.removedCount===2));
});

test("fails closed when reference lookup fails or cleanup deletion fails",async()=>{
 const f=fixture({removeError:true});
 const failedLookup=createCloudPublicationCleanup({
  storage:{listObjects:async()=>({objects:[{name:orphanAttempt,createdAt:old}],hasNext:false,nextCursor:null}),remove:async()=>true},
  findReferencedPaths:async()=>{throw new Error("database unavailable");},
  isAttemptActive:async()=>false,
  now:()=>now
 });
 await assert.rejects(()=>failedLookup.run({prefix}),/reference lookup/);
 const result=await f.cleanup.run({...cleanupIdentity,prefix,dryRun:false,confirmDelete:true});
 assert.equal(result.removedCount,0);
 assert.ok(result.skipped.some(item=>item.reason==="storage_remove_failed"));
});

test("rejects unsafe prefixes, age thresholds and unbounded batches",async()=>{
 const f=fixture();
 await assert.rejects(()=>f.cleanup.run({prefix:"../"}),/exactly an owner-or-project/);
 await assert.rejects(()=>f.cleanup.run({prefix,olderThanMs:1000}),/24 hours/);
 await assert.rejects(()=>f.cleanup.run({prefix,limit:101}),/between 1 and 100/);
 await assert.rejects(()=>f.cleanup.run({prefix,cursor:""}),/cursor is invalid/);
});

test("destructive cleanup fails closed without durable claim callbacks",async()=>{
 const f=fixture();
 const cleanup=createCloudPublicationCleanup({
  storage:{listObjects:async()=>({objects:[{name:orphanAttempt,createdAt:old}],hasNext:false}),remove:async()=>true},
  findReferencedPaths:async()=>[],
  isAttemptActive:async()=>false
 });
 await assert.rejects(()=>cleanup.run({...cleanupIdentity,prefix,dryRun:false,confirmDelete:true}),/durable database claim and completion/);
 assert.equal(f.removed.length,0);
});

test("claim failure prevents deletion and completion failure retains the durable fence",async()=>{
 const failedClaim=fixture({claimError:true});
 const claimResult=await failedClaim.cleanup.run({...cleanupIdentity,prefix,dryRun:false,confirmDelete:true});
 assert.equal(claimResult.removedCount,0);
 assert.equal(failedClaim.removed.length,0);
 assert.ok(claimResult.skipped.some(item=>item.reason==="durable_cleanup_claim_failed"));

 const failedCompletion=fixture({completeError:true});
 const completionResult=await failedCompletion.cleanup.run({...cleanupIdentity,prefix,dryRun:false,confirmDelete:true});
 assert.equal(completionResult.removedCount,2);
 assert.equal(failedCompletion.completed.length,2);
 assert.ok(completionResult.skipped.some(item=>item.reason==="cleanup_claim_completion_failed"));
});

test("destructive cleanup requires an exact publication identity and matching scope",async()=>{
 const f=fixture();
 await assert.rejects(()=>f.cleanup.run({prefix,dryRun:false,confirmDelete:true}),/exact job, owner, optional project, and publication key/);
 await assert.rejects(()=>f.cleanup.run({...cleanupIdentity,ownerId:"823e4567-e89b-42d3-a456-426614174000",prefix,dryRun:false,confirmDelete:true}),/prefix does not match/);
});

test("storage deletion retries reuse the same durable claim token until completion",async()=>{
 const objectPath=prefix+orphanAttempt,removed=[],claimCalls=[],completed=[];
 let removeAttempts=0;
 const stableClaim={claimId:"durable-claim-1",claimToken:"durable-token-1",status:"claimed"};
 const cleanup=createCloudPublicationCleanup({
  storage:{
   async listObjects(){return{objects:[{name:orphanAttempt,createdAt:old}],hasNext:false,nextCursor:null};},
   async remove(path){removeAttempts++;if(removeAttempts===1)throw new Error("temporary storage outage");removed.push(path);return true;}
  },
  findReferencedPaths:async()=>[],
  isAttemptActive:async()=>false,
  claimCleanup:async input=>{claimCalls.push(input);return stableClaim;},
  completeCleanup:async claim=>{completed.push(claim);return true;},
  onEvent:async()=>true,
  now:()=>now
 });
 const args={...cleanupIdentity,prefix,dryRun:false,confirmDelete:true};
 const first=await cleanup.run(args);
 assert.equal(first.removedCount,0);
 assert.ok(first.skipped.some(item=>item.reason==="storage_remove_failed"));
 assert.equal(completed.length,0);

 const second=await cleanup.run(args);
 assert.equal(second.removedCount,1);
 assert.deepEqual(removed,[objectPath]);
 assert.equal(claimCalls.length,2);
 assert.equal(claimCalls[0].objectPath,objectPath);
 assert.equal(claimCalls[1].objectPath,objectPath);
 assert.equal(completed.length,1);
 assert.equal(completed[0].claimToken,stableClaim.claimToken);
});


test("emits bounded per-candidate dry-run audit events and summary counters",async()=>{
 const f=fixture({referenced:[prefix+activeAttempt],active:false});
 const result=await f.cleanup.run({prefix});
 const eligible=f.events.filter(event=>event.type==="publication.cleanup_candidate_eligible");
 const skipped=f.events.filter(event=>event.type==="publication.cleanup_candidate_skipped");
 const completed=f.events.find(event=>event.type==="publication.cleanup_completed");
 assert.equal(eligible.length,1);
 assert.equal(eligible[0].dryRun,true);
 assert.equal(skipped.length,2);
 assert.ok(skipped.every(event=>event.dryRun===true));
 assert.ok(skipped.some(event=>event.reason==="asset_reference_exists"));
 assert.ok(skipped.some(event=>event.reason==="created_at_unavailable"));
 assert.equal(result.skippedCount,2);
 assert.equal(result.failureCount,0);
 assert.equal(completed.skippedCount,2);
 assert.equal(completed.failureCount,0);
});

test("destructive failure audit events preserve the destructive mode and never hide deletion outcomes",async()=>{
 const f=fixture({removeError:true});
 const result=await f.cleanup.run({...cleanupIdentity,prefix,dryRun:false,confirmDelete:true});
 const failed=f.events.filter(event=>event.type==="publication.cleanup_candidate_skipped"&&event.reason==="storage_remove_failed");
 assert.equal(failed.length,2);
 assert.ok(failed.every(event=>event.dryRun===false&&event.claimId));
 assert.equal(result.removedCount,0);
 assert.equal(result.failureCount,2);
 assert.equal(f.events.find(event=>event.type==="publication.cleanup_completed").failureCount,2);
 const throwingAudit=createCloudPublicationCleanup({
  storage:{listObjects:async()=>({objects:[],hasNext:false,nextCursor:null}),remove:async()=>true},
  findReferencedPaths:async()=>[],
  onEvent:async()=>{throw new Error("audit sink unavailable");},
  now:()=>now
 });
 await assert.rejects(()=>throwingAudit.run({prefix}),error=>error.code==="CLOUD_PUBLICATION_CLEANUP_AUDIT_FAILED");
});


test("stops before destructive storage removal when audit persistence is not acknowledged",async()=>{
 const f=fixture({active:false});
 const cleanup=createCloudPublicationCleanup({
  storage:{async listObjects(){return{objects:[{name:orphanAttempt,createdAt:old}],hasNext:false,nextCursor:null};},async remove(path){f.removed.push(path);}},
  findReferencedPaths:async()=>[],
  isAttemptActive:async()=>false,
  claimCleanup:async()=>({claimId:"claim-1",claimToken:"token-1",status:"claimed"}),
  completeCleanup:async()=>true,
  onEvent:async()=>false,
  requireAudit:true,
  now:()=>now
 });
 await assert.rejects(()=>cleanup.run({...cleanupIdentity,prefix,dryRun:false,confirmDelete:true}),error=>error.code==="CLOUD_PUBLICATION_CLEANUP_AUDIT_FAILED");
 assert.equal(f.removed.length,0);
});
