import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleGeminiGcsMirrorAttemptRepository } from "../google-gemini-gcs-mirror-attempt-repository.mjs";

const id="33333333-3333-4333-8333-333333333333";
const ownerId="11111111-1111-4111-8111-111111111111";
const projectId="22222222-2222-4222-8222-222222222222";
const sha256="a".repeat(64);
const crc32c="4waSgw==";
const sessionUri="https://storage.googleapis.com/upload/storage/v1/b/private-media-bucket/o?uploadType=resumable&upload_id=opaque-session-secret";
const key=Buffer.alloc(32,7).toString("base64");
function setup({tamper=false}={}) {
  const rows=[],requests=[];
  const fetchImpl=async (url,options)=>{
    requests.push({url:String(url),options});
    const method=options.method||"GET";
    if(method==="POST"){
      const body=JSON.parse(options.body);
      const row={...body,attempt_key:body.attempt_key,project_id:body.project_id,asset_id:body.asset_id,owner_id:body.owner_id,bucket:body.bucket,object_name:body.object_name,media_type:body.media_type,byte_size:body.byte_size,sha256:body.sha256,crc32c:body.crc32c,session_uri_ciphertext:null,session_expires_at:null,verified_generation:null,verified_metageneration:null,last_error_code:null,attempt_count:1,lease_token:null,lease_expires_at:null,updated_at:new Date().toISOString(),reconciled_at:null};
      rows.push(row);
      return new Response(JSON.stringify([row]),{status:201});
    }
    if(method==="PATCH"){
      const urlObj=new URL(url), attempt=rows[0], body=JSON.parse(options.body);
      Object.assign(attempt,body);
      return new Response(JSON.stringify([attempt]),{status:200});
    }
    if(method==="GET"){
      const row={...rows[0]};
      if(tamper&&row.session_uri_ciphertext)row.session_uri_ciphertext=row.session_uri_ciphertext.slice(0,-2)+"xx";
      return new Response(JSON.stringify([row]),{status:200});
    }
    throw new Error("unexpected method");
  };
  const repository=createGoogleGeminiGcsMirrorAttemptRepository({
    url:"https://project.supabase.co",serviceRoleKey:"service-role-test-key",encryptionKey:key,fetchImpl
  });
  return {repository,requests,rows};
}
const input={assetId:id,ownerId,projectId,bucket:"private-media-bucket",objectName:"mirrors/owner/project/asset/test.mp4",mediaType:"video/mp4",sizeBytes:4,sha256,crc32c};

test("persists resumable session URI only as authenticated AES-256-GCM ciphertext",async()=>{
  const f=setup();
  const attempt=await f.repository.createAttempt(input);
  await f.repository.recordSession({attemptId:attempt.id,sessionUri,expiresAt:new Date(Date.now()+86400000).toISOString()});
  const stored=f.rows[0].session_uri_ciphertext;
  assert.ok(stored);
  assert.equal(stored.includes("opaque-session-secret"),false);
  assert.equal(JSON.stringify(f.requests).includes("opaque-session-secret"),false);
  const recovered=await f.repository.listRecoveryAttempts({before:new Date(Date.now()+1000).toISOString(),limit:10});
  assert.equal(recovered.length,1);
  assert.equal(recovered[0].sessionUri,sessionUri);
  assert.equal(recovered[0].state,"UPLOADING");
  assert.equal(recovered[0].crc32c,crc32c);
});

test("fails closed when encrypted session state is tampered",async()=>{
  const f=setup({tamper:true});
  const attempt=await f.repository.createAttempt(input);
  await f.repository.recordSession({attemptId:attempt.id,sessionUri,expiresAt:new Date(Date.now()+86400000).toISOString()});
  await assert.rejects(()=>f.repository.listRecoveryAttempts({before:new Date(Date.now()+1000).toISOString()}),error=>error.code==="GEMINI_GCS_SESSION_CIPHERTEXT_INVALID");
});

test("rejects invalid encryption keys and non-GCS session endpoints",async()=>{
  assert.throws(()=>createGoogleGeminiGcsMirrorAttemptRepository({url:"https://project.supabase.co",serviceRoleKey:"x",encryptionKey:"not-a-key"}),error=>error.code==="GEMINI_GCS_SESSION_KEY_INVALID");
  const f=setup();
  await assert.rejects(()=>f.repository.recordSession({attemptId:"33333333-3333-4333-8333-333333333333",sessionUri:"https://attacker.example/upload/storage/v1/bucket",expiresAt:new Date(Date.now()+86400000).toISOString()}),error=>error.code==="GEMINI_GCS_SESSION_URI_INVALID");
});


test("retains a recovery lease across OBJECT_VERIFIED and clears it only at terminal registration",async()=>{
  const f=setup();
  const attempt=await f.repository.createAttempt(input);
  await f.repository.recordSession({attemptId:attempt.id,sessionUri,expiresAt:new Date(Date.now()+86400000).toISOString()});
  const leaseToken=await f.repository.claimRecoveryAttempt({attemptId:attempt.id,expectedState:"UPLOADING"});
  assert.ok(leaseToken);
  await f.repository.transition({
    attemptId:attempt.id,expectedState:"UPLOADING",state:"OBJECT_VERIFIED",
    generation:"1762300800000000",metageneration:"3",leaseToken
  });
  assert.equal(f.rows[0].state,"OBJECT_VERIFIED");
  assert.equal(f.rows[0].lease_token,leaseToken);
  assert.ok(f.rows[0].lease_expires_at);
  await f.repository.transition({
    attemptId:attempt.id,expectedState:"OBJECT_VERIFIED",state:"REGISTERED",
    generation:"1762300800000000",metageneration:"3",leaseToken
  });
  assert.equal(f.rows[0].state,"REGISTERED");
  assert.equal(f.rows[0].lease_token,null);
  assert.equal(f.rows[0].lease_expires_at,null);
  assert.ok(f.rows[0].reconciled_at);
});
