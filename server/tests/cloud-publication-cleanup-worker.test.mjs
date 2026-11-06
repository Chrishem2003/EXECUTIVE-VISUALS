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
function fixture({jobRow=job,deleteEnabled=false,confirmDelete=false}={}){
 const calls=[],removed=[],audit=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  const parsed=new URL(url);
  if(parsed.pathname.endsWith("/asset_publications"))return response([publication]);
  if(parsed.pathname.endsWith("/jobs"))return response(jobRow?[jobRow]:[]);
  if(parsed.pathname.endsWith("/assets"))return response([]);
  if(parsed.pathname.endsWith("/rpc/claim_asset_publication_cleanup_v1"))return response([{claim_id:"77777777-7777-4777-8777-777777777777",claim_token:"99999999-9999-4999-8999-999999999999",object_path:objectPath,status:"claimed"}]);
  if(parsed.pathname.endsWith("/rpc/complete_asset_publication_cleanup_v1"))return response(true);
  if(parsed.pathname.endsWith("/publication_cleanup_audit_events")&&options.method==="POST"){audit.push(JSON.parse(options.body));return response(null,201);}
  throw new Error("Unexpected request "+options.method+" "+parsed.pathname);
 };
 const storage={async listObjects(args){assert.equal(args.prefix,owner+"/"+asset+"/");return{objects:[{name:attempt,createdAt:"2026-11-05T00:00:00.000Z"}],hasNext:false,nextCursor:null};},async remove(path){removed.push(path);return true;}};
 const worker=createCloudPublicationCleanupWorker({
  url:"https://example.supabase.co",serviceRoleKey:"private-key",fetchImpl,storage,now,
  olderThanMs:24*60*60*1000,publicationLimit:5,objectLimit:10,pollIntervalMs:10000,
  dryRun:!deleteEnabled,allowDelete:deleteEnabled,confirmDelete,
  onLog:()=>{}
 });
 return{worker,calls,removed,audit};
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
