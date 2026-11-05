import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleDriveExportAttemptStore } from "../google-drive-export-attempt-store.mjs";

const ownerId="11111111-1111-4111-8111-111111111111";
const attemptKey="a".repeat(64);
const row={attempt_key:attemptKey,owner_id:ownerId,project_id:null,asset_id:"33333333-3333-4333-8333-333333333333",
 parent_folder_id:null,drive_file_id:"driveFile_123456789",mime_type:"video/mp4",byte_size:5,sha256:"b".repeat(64),
 encrypted_session_uri:null,state:"PREPARED",attempt_count:1,updated_at:"2026-11-05T00:00:00Z"};
function harness(initialRows=[row]){
 const rows=initialRows.map(value=>({...value})),calls=[];
 const store=createGoogleDriveExportAttemptStore({url:"https://example.supabase.co",serviceRoleKey:"service-role-secret-123456789",
  encryptionKey:"0123456789abcdef0123456789abcdef",fetchImpl:async(url,options)=>{
   calls.push({url:String(url),options});
   if(options.method==="POST"){
    const body=JSON.parse(options.body);
    if(rows.some(x=>x.attempt_key===body.attempt_key))return new Response("[]",{status:201});
    const created={...body,id:"row-id",attempt_count:1,updated_at:"2026-11-05T00:00:00Z"};
    rows.push(created);
    return new Response(JSON.stringify([created]),{status:201});
   }
   if(options.method==="PATCH"){
    const body=JSON.parse(options.body), target=rows[0], query=String(url);
    const leaseMatch=query.match(/[?&]lease_token=eq\.([0-9a-f-]+)/);
    if(leaseMatch&&target.lease_token!==leaseMatch[1])return new Response("[]",{status:200});
    const expiryMatch=query.match(/[?&]lease_expires_at=gt\.([^&]+)/);
    if(expiryMatch&&Date.parse(target.lease_expires_at)<=Date.parse(decodeURIComponent(expiryMatch[1])))return new Response("[]",{status:200});
    const reclaimMatch=query.match(/lease_expires_at\.lt\.([^)&]+)/);
    if(reclaimMatch&&target.lease_expires_at&&Date.parse(target.lease_expires_at)>=Date.parse(decodeURIComponent(reclaimMatch[1])))return new Response("[]",{status:200});
    if(query.includes("state=in.")&&!["PREPARED","UPLOADING","OUTCOME_UNKNOWN"].includes(target.state))return new Response("[]",{status:200});
    const stateEqMatch=query.match(/[?&]state=eq\.([A-Z_]+)/);
    if(stateEqMatch&&target.state!==stateEqMatch[1])return new Response("[]",{status:200});
    Object.assign(target,body);
    return new Response(JSON.stringify([target]),{status:200});
   }
   return new Response(JSON.stringify(rows.filter(x=>url.includes("attempt_key=eq."+attemptKey))),{status:200});
  }});
 return {store,calls,rows};
}
test("creates an owner-scoped durable export attempt without exposing session credentials",async()=>{
 const h=harness();
 const result=await h.store.createOrGet({attemptKey,ownerId,assetId:row.asset_id,driveFileId:row.drive_file_id,mimeType:"video/mp4",byteSize:5,sha256:row.sha256});
 assert.equal(result.state,"PREPARED");
 assert.match(h.calls[0].url,/on_conflict=attempt_key/);
 assert.equal(h.calls[0].options.headers["content-profile"],"executive_visuals");
});

test("concurrent creates converge on the first persisted canonical Drive file ID",async()=>{
 const h=harness([]);
 const [first,second]=await Promise.all([
  h.store.createOrGet({attemptKey,ownerId,assetId:row.asset_id,driveFileId:"driveFile_FIRST12345",
   mimeType:"video/mp4",byteSize:5,sha256:row.sha256}),
  h.store.createOrGet({attemptKey,ownerId,assetId:row.asset_id,driveFileId:"driveFile_SECOND123",
   mimeType:"video/mp4",byteSize:5,sha256:row.sha256})
 ]);
 assert.equal(first.driveFileId,second.driveFileId);
 assert.equal(first.driveFileId,h.rows[0].drive_file_id);
 assert.equal(h.rows.length,1);
});
test("rejects an idempotency key reused for a different private asset",async()=>{
 const h=harness();
 await assert.rejects(()=>h.store.createOrGet({attemptKey,ownerId,assetId:"44444444-4444-4444-8444-444444444444",
  driveFileId:"driveFile_DIFFERENT123",mimeType:"video/mp4",byteSize:5,sha256:row.sha256}),
  error=>error.code==="GOOGLE_DRIVE_EXPORT_IDEMPOTENCY_CONFLICT");
 assert.equal(h.rows.length,1);
});
test("claims a Drive export attempt with a bounded exclusive lease",async()=>{
 const h=harness();
 const lease=await h.store.claim({attemptKey,ownerId});
 assert.match(lease,/^[0-9a-f-]{36}$/);
 assert.match(h.calls[0].url,/lease_expires_at/);
 assert.match(h.calls[0].url,/state=in\.\(PREPARED,UPLOADING,OUTCOME_UNKNOWN\)/);
 assert.equal(h.rows[0].lease_token,lease);
 assert.ok(Date.parse(h.rows[0].lease_expires_at)>Date.now());
});
test("allows exactly one of two simultaneous workers to claim a prepared export",async()=>{
 const h=harness();
 const results=await Promise.all([
  h.store.claim({attemptKey,ownerId}),
  h.store.claim({attemptKey,ownerId})
 ]);
 assert.equal(results.filter(Boolean).length,1);
 assert.equal(results.filter(value=>value===null).length,1);
 assert.equal(h.rows[0].lease_token,results.find(Boolean));
 assert.ok(Date.parse(h.rows[0].lease_expires_at)>Date.now());
});
test("does not automatically reclaim terminal or reconciliation-required attempts",async()=>{
 const h=harness();
 h.rows[0].state="RECONCILIATION_REQUIRED";
 assert.equal(await h.store.claim({attemptKey,ownerId}),null);
 assert.equal(h.rows[0].state,"RECONCILIATION_REQUIRED");
 h.rows[0].state="FAILED";
 assert.equal(await h.store.claim({attemptKey,ownerId}),null);
 assert.equal(h.rows[0].state,"FAILED");
 h.rows[0].state="COMPLETED";
 assert.equal(await h.store.claim({attemptKey,ownerId}),null);
 assert.equal(h.rows[0].state,"COMPLETED");
});

test("uses a separate short lease to reconcile quarantined exports without reopening upload claims",async()=>{
 const h=harness();
 h.rows[0].state="RECONCILIATION_REQUIRED";
 assert.equal(await h.store.claim({attemptKey,ownerId}),null);
 const lease=await h.store.claimForReconciliation({attemptKey,ownerId});
 assert.match(lease,/^[0-9a-f-]{36}$/);
 assert.equal(h.rows[0].lease_token,lease);
 assert.match(h.calls.at(-1).url,/state=eq\.RECONCILIATION_REQUIRED/);
 assert.match(h.calls.at(-1).url,/lease_expires_at/);
 assert.equal(h.rows[0].state,"RECONCILIATION_REQUIRED");
 assert.ok(h.rows[0].lease_token);
 assert.equal(await h.store.claimForReconciliation({attemptKey,ownerId}),null);
 h.rows[0].lease_expires_at=new Date(Date.now()-1000).toISOString();
 const reclaimed=await h.store.claimForReconciliation({attemptKey,ownerId});
 assert.match(reclaimed,/^[0-9a-f-]{36}$/);
 assert.notEqual(reclaimed,lease);
});
test("allows exactly one simultaneous reconciliation worker to claim a quarantined export",async()=>{
 const h=harness();
 h.rows[0].state="RECONCILIATION_REQUIRED";
 const results=await Promise.all([
  h.store.claimForReconciliation({attemptKey,ownerId}),
  h.store.claimForReconciliation({attemptKey,ownerId})
 ]);
 assert.equal(results.filter(Boolean).length,1);
 assert.equal(results.filter(value=>value===null).length,1);
 assert.equal(h.rows[0].lease_token,results.find(Boolean));
 assert.ok(Date.parse(h.rows[0].lease_expires_at)>Date.now());
 assert.equal(h.rows[0].state,"RECONCILIATION_REQUIRED");
});
test("rejects malformed attempt keys before issuing a lease update",async()=>{
 const h=harness();
 await assert.rejects(()=>h.store.claim({attemptKey:"bad",ownerId}),
  error=>error.code==="GOOGLE_DRIVE_EXPORT_ATTEMPT_INVALID");
 assert.equal(h.calls.length,0);
});
test("encrypts a validated Google Drive resumable session URI at rest",async()=>{
 const h=harness(),uri="https://www.googleapis.com/upload/drive/v3/files?upload_id=private-session";
 const leaseToken=await h.store.claim({attemptKey,ownerId});
 await h.store.saveSession({attemptKey,ownerId,sessionUri:uri,leaseToken});
 assert.notEqual(h.rows[0].encrypted_session_uri,uri);
 assert.match(h.rows[0].encrypted_session_uri,/^gdrive-session:v1:/);
 assert.equal((await h.store.get(attemptKey,ownerId)).sessionUri,uri);
});
test("rejects untrusted upload session hosts before persistence",async()=>{
 const h=harness();
 const leaseToken=await h.store.claim({attemptKey,ownerId});
 await assert.rejects(()=>h.store.saveSession({attemptKey,ownerId,leaseToken,sessionUri:"https://attacker.example/upload/drive/v3/files?upload_id=x"}),
  error=>error.code==="GOOGLE_DRIVE_EXPORT_SESSION_INVALID");
 assert.equal(h.calls.length,1);
});
test("marks completed attempts and clears encrypted resumable credentials",async()=>{
 const h=harness();
 const leaseToken=await h.store.claim({attemptKey,ownerId});
 await h.store.saveSession({attemptKey,ownerId,sessionUri:"https://www.googleapis.com/upload/drive/v3/files?upload_id=private-session",leaseToken});
 const done=await h.store.mark({attemptKey,ownerId,state:"COMPLETED",leaseToken,webViewLink:"https://drive.google.com/file/d/driveFile_123456789/view"});
 assert.equal(done.state,"COMPLETED");
 assert.equal(done.sessionUri,null);
 assert.equal(h.rows[0].encrypted_session_uri,null);
});
test("requires an active lease token for every state mutation",async()=>{
 const h=harness();
 await assert.rejects(()=>h.store.mark({attemptKey,ownerId,state:"OUTCOME_UNKNOWN"}),
  error=>error.code==="GOOGLE_DRIVE_EXPORT_ATTEMPT_INVALID");
 assert.equal(h.calls.length,0);
 const leaseToken=await h.store.claim({attemptKey,ownerId});
 await h.store.mark({attemptKey,ownerId,state:"OUTCOME_UNKNOWN",leaseToken});
 assert.match(h.calls.at(-1).url,/lease_token=eq\./);
});
test("prevents a stale worker from mutating an attempt after its lease changes",async()=>{
 const h=harness();
 await h.store.claim({attemptKey,ownerId});
 await assert.rejects(()=>h.store.mark({attemptKey,ownerId,state:"OUTCOME_UNKNOWN",
  leaseToken:"55555555-5555-4555-8555-555555555555"}),
  error=>error.code==="GOOGLE_DRIVE_EXPORT_STORE_FAILED");
 assert.equal(h.rows[0].state,"PREPARED");
});
test("rejects state writes from a worker whose lease expired even before another worker reclaims it",async()=>{
 const h=harness();
 const leaseToken=await h.store.claim({attemptKey,ownerId});
 h.rows[0].lease_expires_at=new Date(Date.now()-1000).toISOString();
 await assert.rejects(()=>h.store.mark({attemptKey,ownerId,state:"OUTCOME_UNKNOWN",leaseToken}),
  error=>error.code==="GOOGLE_DRIVE_EXPORT_STORE_FAILED");
 assert.equal(h.rows[0].state,"PREPARED");
 assert.match(h.calls.at(-1).url,/lease_expires_at=gt\./);
});
test("rejects session persistence from an expired export lease",async()=>{
 const h=harness();
 const leaseToken=await h.store.claim({attemptKey,ownerId});
 h.rows[0].lease_expires_at=new Date(Date.now()-1000).toISOString();
 await assert.rejects(()=>h.store.saveSession({attemptKey,ownerId,leaseToken,
  sessionUri:"https://www.googleapis.com/upload/drive/v3/files?upload_id=private-session"}),
  error=>error.code==="GOOGLE_DRIVE_EXPORT_STORE_FAILED");
 assert.equal(h.rows[0].encrypted_session_uri,null);
});
test("rejects corrupted durable lease pairs and completed rows retaining upload credentials",async()=>{
 const h=harness();
 h.rows[0].lease_token="not-a-uuid";
 await assert.rejects(()=>h.store.get(attemptKey,ownerId),error=>error.code==="GOOGLE_DRIVE_EXPORT_STORE_RESPONSE_INVALID");
 h.rows[0].lease_token=null;
 h.rows[0].lease_expires_at="2026-11-06T00:00:00Z";
 await assert.rejects(()=>h.store.get(attemptKey,ownerId),error=>error.code==="GOOGLE_DRIVE_EXPORT_STORE_RESPONSE_INVALID");
 h.rows[0].lease_expires_at=null;
 h.rows[0].state="COMPLETED";
 h.rows[0].encrypted_session_uri="gdrive-session:v1:invalid";
 await assert.rejects(()=>h.store.get(attemptKey,ownerId),error=>error.code==="GOOGLE_DRIVE_EXPORT_STORE_RESPONSE_INVALID");
});

test("rejects malformed owner, attempt and unsafe session records",async()=>{
 const h=harness();
 await assert.rejects(()=>h.store.get(attemptKey,"bad"),error=>error.code==="GOOGLE_DRIVE_EXPORT_SCOPE_INVALID");
 await assert.rejects(()=>h.store.createOrGet({attemptKey:"bad",ownerId,assetId:row.asset_id,driveFileId:row.drive_file_id,mimeType:"video/mp4",byteSize:5,sha256:row.sha256}),
  error=>error.code==="GOOGLE_DRIVE_EXPORT_ATTEMPT_INVALID");
});
