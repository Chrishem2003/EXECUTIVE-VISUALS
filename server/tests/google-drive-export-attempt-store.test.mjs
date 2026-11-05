import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleDriveExportAttemptStore } from "../google-drive-export-attempt-store.mjs";

const ownerId="11111111-1111-4111-8111-111111111111";
const attemptKey="a".repeat(64);
const row={attempt_key:attemptKey,owner_id:ownerId,project_id:null,asset_id:"33333333-3333-4333-8333-333333333333",
 parent_folder_id:null,drive_file_id:"driveFile_123456789",mime_type:"video/mp4",byte_size:5,sha256:"b".repeat(64),
 encrypted_session_uri:null,state:"PREPARED",attempt_count:1,updated_at:"2026-11-05T00:00:00Z"};
function harness(){
 const rows=[{...row}],calls=[];
 const store=createGoogleDriveExportAttemptStore({url:"https://example.supabase.co",serviceRoleKey:"service-role-secret-123456789",
  encryptionKey:"0123456789abcdef0123456789abcdef",fetchImpl:async(url,options)=>{
   calls.push({url:String(url),options});
   if(options.method==="POST"){
    const body=JSON.parse(options.body);
    if(!rows.some(x=>x.attempt_key===body.attempt_key)){rows.push({...body,id:"row-id",attempt_count:1,updated_at:"2026-11-05T00:00:00Z"});}
    return new Response(JSON.stringify(rows.filter(x=>x.attempt_key===attemptKey)),{status:201});
   }
   if(options.method==="PATCH"){
    const body=JSON.parse(options.body), target=rows[0];
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

test("claims a Drive export attempt with a bounded exclusive lease",async()=>{
 const h=harness();
 const lease=await h.store.claim({attemptKey,ownerId});
 assert.match(lease,/^[0-9a-f-]{36}$/);
 assert.match(h.calls[0].url,/lease_expires_at/);
 assert.match(h.calls[0].url,/state=neq.COMPLETED/);
 assert.equal(h.rows[0].lease_token,lease);
 assert.ok(Date.parse(h.rows[0].lease_expires_at)>Date.now());
});
test("rejects malformed attempt keys before issuing a lease update",async()=>{
 const h=harness();
 await assert.rejects(()=>h.store.claim({attemptKey:"bad",ownerId}),
  error=>error.code==="GOOGLE_DRIVE_EXPORT_ATTEMPT_INVALID");
 assert.equal(h.calls.length,0);
});
test("encrypts a validated Google Drive resumable session URI at rest",async()=>{
 const h=harness(),uri="https://www.googleapis.com/upload/drive/v3/files?upload_id=private-session";
 await h.store.saveSession({attemptKey,ownerId,sessionUri:uri});
 assert.notEqual(h.rows[0].encrypted_session_uri,uri);
 assert.match(h.rows[0].encrypted_session_uri,/^gdrive-session:v1:/);
 assert.equal((await h.store.get(attemptKey,ownerId)).sessionUri,uri);
});
test("rejects untrusted upload session hosts before persistence",async()=>{
 const h=harness();
 await assert.rejects(()=>h.store.saveSession({attemptKey,ownerId,sessionUri:"https://attacker.example/upload/drive/v3/files?upload_id=x"}),
  error=>error.code==="GOOGLE_DRIVE_EXPORT_SESSION_INVALID");
 assert.equal(h.calls.length,0);
});
test("marks completed attempts and clears encrypted resumable credentials",async()=>{
 const h=harness();
 await h.store.saveSession({attemptKey,ownerId,sessionUri:"https://www.googleapis.com/upload/drive/v3/files?upload_id=private-session"});
 const done=await h.store.mark({attemptKey,ownerId,state:"COMPLETED",webViewLink:"https://drive.google.com/file/d/driveFile_123456789/view"});
 assert.equal(done.state,"COMPLETED");
 assert.equal(done.sessionUri,null);
 assert.equal(h.rows[0].encrypted_session_uri,null);
});
test("rejects malformed owner, attempt and unsafe session records",async()=>{
 const h=harness();
 await assert.rejects(()=>h.store.get(attemptKey,"bad"),error=>error.code==="GOOGLE_DRIVE_EXPORT_SCOPE_INVALID");
 await assert.rejects(()=>h.store.createOrGet({attemptKey:"bad",ownerId,assetId:row.asset_id,driveFileId:row.drive_file_id,mimeType:"video/mp4",byteSize:5,sha256:row.sha256}),
  error=>error.code==="GOOGLE_DRIVE_EXPORT_ATTEMPT_INVALID");
});
