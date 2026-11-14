import test from "node:test";
import assert from "node:assert/strict";
import {createCloudPublicationCleanupWorker} from "../cloud-publication-cleanup-worker.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const asset="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const jobId="55555555-5555-4555-8555-555555555555";
const publicationKey="test:cleanup-worker";
const attempt="attempt-88888888-8888-4888-8888-888888888888.mp4";
const objectPath=owner+"/"+asset+"/"+attempt;
const now=()=>new Date("2026-11-07T12:00:00.000Z");
const publication={owner_id:owner,project_id:null,job_id:jobId,publication_key:publicationKey,asset_id:asset,status:"reserved",updated_at:"2026-11-05T00:00:00.000Z"};
const job={id:jobId,status:"failed",lease_expires_at:"2026-11-06T00:00:00.000Z"};
function response(data,status=200){return{ok:status>=200&&status<300,status,async text(){return JSON.stringify(data);}};}

test("publication cleanup worker checks the required durable tables before starting",async()=>{
 const calls=[];
 const worker=createCloudPublicationCleanupWorker({url:"https://example.supabase.co",serviceRoleKey:"service-secret",fetchImpl:async(url,options)=>{calls.push(url);return response([]);},storage:{listObjects:async()=>({objects:[],hasNext:false,nextCursor:null}),remove:async()=>true}});
 const readiness=await worker.checkReadiness();
 assert.equal(readiness.ready,true);
 assert.deepEqual(readiness.tables,["assets","jobs","asset_publications","asset_publication_cleanup_claims","publication_cleanup_audit_events"]);
 assert.equal(calls.length,5);
});
function fixture({jobRow=job,deleteEnabled=false,confirmDelete=false,storageOverride=null,completeFailures=0,objectLimit=10,initialPendingClaims=[],publicationRows=[publication],clock=now}={}){
 const calls=[],removed=[],audit=[];
 let pendingClaims=[...initialPendingClaims],objectExists=true,remainingCompleteFailures=completeFailures;
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  const parsed=new URL(url);
  if(parsed.pathname.endsWith("/asset_publication_cleanup_claims")){
   const offset=Number(parsed.searchParams.get("offset")||0),limit=Number(parsed.searchParams.get("limit")||objectLimit);
   return response(pendingClaims.slice(offset,offset+limit));
  }
  if(parsed.pathname.endsWith("/asset_publications"))return response(parsed.searchParams.has("id")?[publication]:publicationRows);
  if(parsed.pathname.endsWith("/jobs"))return response(jobRow?[jobRow]:[]);
  if(parsed.pathname.endsWith("/assets"))return response([]);
  if(parsed.pathname.endsWith("/rpc/claim_asset_publication_cleanup_v1")){
   const claim={id:"77777777-7777-4777-8777-777777777777",claim_token:"99999999-9999-4999-8999-999999999999",object_path:objectPath,job_id:jobId,owner_id:owner,project_id:null,publication_id:"66666666-6666-4666-8666-666666666666",status:"claimed"};
   pendingClaims=[claim];
   return response([{claim_id:claim.id,claim_token:claim.claim_token,object_path:objectPath,status:"claimed"}]);
  }
  if(parsed.pathname.endsWith("/rpc/complete_asset_publication_cleanup_v1")){
   if(remainingCompleteFailures>0){remainingCompleteFailures--;return response({message:"temporary completion failure"},500);}
   pendingClaims=[];return response(true);
  }
  if(parsed.pathname.endsWith("/publication_cleanup_audit_events")&&options.method==="POST"){audit.push(JSON.parse(options.body));return response(null,201);}
  throw new Error("Unexpected request "+options.method+" "+parsed.pathname);
 };
 const storage=storageOverride||{async listObjects(args){assert.equal(args.prefix,owner+"/"+asset+"/");return{objects:objectExists?[{name:attempt,createdAt:"2026-11-05T00:00:00.000Z"}]:[],hasNext:false,nextCursor:null};},async remove(path){removed.push(path);if(!objectExists){const error=new Error("object missing");error.status=404;error.code="CLOUD_STORAGE_HTTP_404";throw error;}objectExists=false;return true;}};
 const worker=createCloudPublicationCleanupWorker({
  url:"https://example.supabase.co",serviceRoleKey:"private-key",fetchImpl,storage,now:clock,
  olderThanMs:24*60*60*1000,publicationLimit:5,objectLimit,pollIntervalMs:10000,
  dryRun:!deleteEnabled,allowDelete:deleteEnabled,confirmDelete,
  onLog:()=>{}
 });
 const makeWorker=()=>createCloudPublicationCleanupWorker({url:"https://example.supabase.co",serviceRoleKey:"private-key",fetchImpl,storage,now:clock,olderThanMs:24*60*60*1000,publicationLimit:5,objectLimit,pollIntervalMs:10000,dryRun:!deleteEnabled,allowDelete:deleteEnabled,confirmDelete,onLog:()=>{}});
 return{worker,calls,removed,audit,makeWorker,get pendingClaims(){return pendingClaims;},set pendingClaims(value){pendingClaims=value;}};
}
test("runs bounded dry-run cleanup and persists its audit evidence without deleting storage",async()=>{
 const f=fixture();
 const result=await f.worker.runCycle();
 assert.equal(result.dryRun,true);
 assert.equal(result.publicationsScanned,1);
 assert.equal(result.results[0].eligibleCount,1);
 assert.equal(result.results[0].removedCount,0);
 assert.deepEqual(f.removed,[]);
 assert.ok(f.audit.some(event=>event.event_type==="publication.cleanup_candidate_eligible"));
 assert.ok(f.audit.some(event=>event.event_type==="publication.cleanup_completed"));
});
test("refuses destructive mode unless both independent operator gates are enabled",()=>{
 assert.throws(()=>createCloudPublicationCleanupWorker({url:"https://example.supabase.co",serviceRoleKey:"x",dryRun:false,allowDelete:false,confirmDelete:true}),/both explicit confirmation and the worker delete enable flag/);
 assert.throws(()=>createCloudPublicationCleanupWorker({url:"https://example.supabase.co",serviceRoleKey:"x",dryRun:false,allowDelete:true,confirmDelete:false}),/both explicit confirmation and the worker delete enable flag/);
});
test("deletes only after durable audit, authoritative claim, storage removal and tombstone completion",async()=>{
 const f=fixture({deleteEnabled:true,confirmDelete:true});
 const result=await f.worker.runCycle();
 assert.equal(result.dryRun,false);
 assert.equal(result.results[0].removedCount,1);
 assert.deepEqual(f.removed,[objectPath]);
 assert.ok(f.calls.some(call=>call.url.includes("rpc/claim_asset_publication_cleanup_v1")));
 assert.ok(f.calls.some(call=>call.url.includes("rpc/complete_asset_publication_cleanup_v1")));
 assert.ok(f.audit.some(event=>event.event_type==="publication.orphan_removed"&&event.dry_run===false));
});
test("skips nonterminal jobs before listing storage or writing cleanup events",async()=>{
 const f=fixture({jobRow:{...job,status:"processing",lease_expires_at:"2026-11-08T00:00:00.000Z"}});
 const result=await f.worker.runCycle();
 assert.equal(result.results[0].status,"skipped_nonterminal_job");
 assert.equal(f.calls.some(call=>call.url.includes("/assets?")),false);
 assert.deepEqual(f.removed,[]);
 assert.deepEqual(f.audit,[]);
});


test("traverses a bounded continuation page rather than repeatedly scanning the first storage page",async()=>{
 const pageCalls=[];
 const storage={
  async listObjects(args){
   pageCalls.push(args.cursor);
   if(args.cursor===null)return{objects:[{name:attempt,createdAt:"2026-11-05T00:00:00.000Z"}],hasNext:true,nextCursor:"page-2"};
   assert.equal(args.cursor,"page-2");
   return{objects:[],hasNext:false,nextCursor:null};
  },
  async remove(){throw new Error("dry-run must not delete");}
 };
 const f=fixture({storageOverride:storage});
 const result=await f.worker.runCycle();
 assert.equal(result.results[0].pages,2);
 assert.equal(result.results[0].eligibleCount,1);
 assert.deepEqual(pageCalls,[null,"page-2"]);
});


test("reconciles a durable pending claim after storage deletion succeeded but completion failed",async()=>{
 const f=fixture({deleteEnabled:true,confirmDelete:true,completeFailures:1});
 const first=await f.worker.runCycle();
 assert.equal(first.results[0].removedCount,1);
 assert.equal(first.results[0].failureCount,1);
 assert.equal(f.pendingClaims.length,1);
 assert.equal(f.removed.length,1);

 // Simulate a process restart: a new worker instance has no in-memory cursor or
 // claim state, so recovery must come from the durable database claim row.
 const restarted=f.makeWorker();
 const recovered=await restarted.runCycle();
 assert.equal(recovered.pendingClaims.scanned,1);
 assert.equal(recovered.pendingClaims.completed,1);
 assert.equal(recovered.pendingClaims.failed,0);
 assert.equal(f.pendingClaims.length,0);
 assert.ok(f.audit.some(event=>event.event_type==="publication.orphan_removed"&&event.claim_id==="77777777-7777-4777-8777-777777777777"));
});


test("rotates bounded pending-claim pages so an invalid oldest claim cannot starve later claims",async()=>{
 let instant=Date.parse("2026-11-07T12:00:00.000Z");
 const clock=()=>new Date(instant+=10001);
 const invalid={id:"invalid-claim"};
 const valid={id:"77777777-7777-4777-8777-777777777777",claim_token:"99999999-9999-4999-8999-999999999999",object_path:objectPath,job_id:jobId,owner_id:owner,project_id:null,publication_id:"66666666-6666-4666-8666-666666666666",status:"claimed"};
 const f=fixture({deleteEnabled:true,confirmDelete:true,objectLimit:1,initialPendingClaims:[invalid,valid],publicationRows:[],clock});
 const first=await f.worker.runCycle();
 assert.equal(first.pendingClaims.scanned,1);
 assert.equal(first.pendingClaims.skipped,1);
 assert.equal(first.pendingClaims.offset,1);
 const second=await f.worker.runCycle();
 assert.equal(second.pendingClaims.scanned,1);
 assert.equal(second.pendingClaims.completed,1);
 assert.equal(f.pendingClaims.length,0);
 const offsets=f.calls.filter(call=>call.url.includes("/asset_publication_cleanup_claims")).map(call=>new URL(call.url).searchParams.get("offset"));
 assert.deepEqual(offsets,["0","1"]);
});
