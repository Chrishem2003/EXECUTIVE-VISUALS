import test from "node:test";
import assert from "node:assert/strict";
import { createCloudPublicationAuditSink,createCloudPublicationAuditHandler } from "../cloud-publication-audit.mjs";

const ownerId="11111111-1111-4111-8111-111111111111";
const projectId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const jobId="55555555-5555-4555-8555-555555555555";
const runId="99999999-9999-4999-8999-999999999999";
const claimId="77777777-7777-4777-8777-777777777777";
const objectPath=projectId+"/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/attempt-88888888-8888-4888-8888-888888888888.mp4";
const base={url:"https://example.supabase.co",serviceRoleKey:"server-only-secret",ownerId,projectId,jobId,runId,publicationKey:"integration:cleanup-audit",now:()=>new Date("2026-11-07T12:00:00.000Z")};

test("persists only allowlisted cleanup event fields using server-only credentials",async()=>{
 let request;
 const sink=createCloudPublicationAuditSink({...base,actorType:"admin",actorId:ownerId,fetchImpl:async(url,options)=>{request={url,options};return{ok:true,status:201};}});
 assert.equal(await sink.onEvent({type:"publication.cleanup_candidate_skipped",objectPath,claimId,reason:"storage_remove_failed",dryRun:false,createdAt:"2026-11-06T00:00:00.000Z",at:"2026-11-07T11:59:00.000Z",unexpectedSecret:"must-not-be-stored"}),true);
 assert.equal(request.url,"https://example.supabase.co/rest/v1/publication_cleanup_audit_events");
 assert.equal(request.options.method,"POST");
 assert.equal(request.options.headers.apikey,"server-only-secret");
 assert.equal(request.options.headers.authorization,"Bearer server-only-secret");
 assert.equal(request.options.headers["content-profile"],"executive_visuals");
 assert.equal(request.options.headers.prefer,"return=minimal");
 assert.deepEqual(JSON.parse(request.options.body),{
  run_id:runId,event_type:"publication.cleanup_candidate_skipped",actor_type:"admin",actor_id:ownerId,
  job_id:jobId,owner_id:ownerId,project_id:projectId,publication_key:"integration:cleanup-audit",
  claim_id:claimId,object_path:objectPath,reason:"storage_remove_failed",dry_run:false,
  details:{createdAt:"2026-11-06T00:00:00.000Z"},occurred_at:"2026-11-07T11:59:00.000Z"
 });
 assert.deepEqual(sink.getStatus(),{attempted:1,stored:1,failed:0,lastFailureCode:null});
});

test("rejects unknown events, malformed identifiers and cross-scope object paths",async()=>{
 let requests=0;
 const sink=createCloudPublicationAuditSink({...base,fetchImpl:async()=>{requests++;return{ok:true,status:201};}});
 await assert.rejects(()=>sink.onEvent({type:"publication.cleanup_started",dryRun:true}),/event type is not allowed/);
 await assert.rejects(()=>sink.onEvent({type:"publication.orphan_removed",dryRun:false,objectPath:ownerId+"/../../secret"}),/exact owner\/project attempt scope/);
 await assert.rejects(()=>sink.onEvent({type:"publication.orphan_removed",dryRun:false,objectPath,claimId:"not-a-uuid"}),/claim ID must be a UUID/);
 assert.equal(requests,0);
});

test("reports remote failures without leaking credentials or interrupting cleanup callers",async()=>{
 const failures=[];
 const sink=createCloudPublicationAuditSink({...base,onFailure:async failure=>failures.push(failure),fetchImpl:async()=>({ok:false,status:503})});
 assert.equal(await sink.onEvent({type:"publication.cleanup_completed",dryRun:true,scanned:4,candidateCount:2,eligibleCount:1,removedCount:0,skippedCount:1,failureCount:0}),false);
 assert.deepEqual(failures,[{eventType:"publication.cleanup_completed",code:"PUBLICATION_AUDIT_HTTP_503"}]);
 assert.deepEqual(sink.getStatus(),{attempted:1,stored:0,failed:1,lastFailureCode:"PUBLICATION_AUDIT_HTTP_503"});
});

test("requires TLS outside localhost and a valid owner identity",()=>{
 assert.throws(()=>createCloudPublicationAuditSink({...base,url:"http://example.supabase.co"}),/must use HTTPS/);
 assert.throws(()=>createCloudPublicationAuditSink({...base,ownerId:"bad"}),/owner ID must be a UUID/);
});


test("audit handler retries transient sink failures and requires a durable acknowledgement",async()=>{
 let attempts=0;const retries=[];
 const handler=createCloudPublicationAuditHandler({
  sink:{async onEvent(){attempts++;return attempts===3;}},
  maxAttempts:3,retryDelayMs:0,onRetry:event=>retries.push(event)
 });
 assert.equal(await handler.onEvent({type:"publication.cleanup_completed"}),true);
 assert.equal(attempts,3);
 assert.equal(retries.length,2);
});
test("audit handler stops after its bounded retry budget",async()=>{
 let attempts=0;
 const handler=createCloudPublicationAuditHandler({sink:{async onEvent(){attempts++;return false;}},maxAttempts:2,retryDelayMs:0});
 await assert.rejects(()=>handler.onEvent({type:"publication.cleanup_completed"}),error=>error.code==="CLOUD_PUBLICATION_AUDIT_RETRIES_EXHAUSTED");
 assert.equal(attempts,2);
});
