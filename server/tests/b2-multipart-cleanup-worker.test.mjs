import test from "node:test";
import assert from "node:assert/strict";
import {createB2MultipartCleanupWorker} from "../b2-multipart-cleanup-worker.mjs";

const session={id:"423e4567-e89b-42d3-a456-426614174000",ownerId:"123e4567-e89b-42d3-a456-426614174000",objectPath:"223e4567-e89b-42d3-a456-426614174000/323e4567-e89b-42d3-a456-426614174000/original.mp4",uploadId:"upload_12345678"};

function fixture({sessions=[session],abortError=null,finalize=true}={}){
 const calls=[],events=[];
 const store={
  async claimExpiredSessions(options){calls.push(["claim",options]);return sessions;},
  async markAborted(input){calls.push(["finalize",input]);return finalize;}
 };
 const storage={async abortMultipartUpload(path,uploadId){calls.push(["abort",path,uploadId]);if(abortError)throw abortError;return true;}};
 const worker=createB2MultipartCleanupWorker({store,storage,onEvent:event=>events.push(event),clock:()=>new Date("2026-11-17T12:00:00.000Z")});
 return{worker,calls,events};
}

test("aborts only claimed expired multipart uploads and durably marks them expired",async()=>{
 const f=fixture();
 const result=await f.worker.runCycle();
 assert.deepEqual(result,{scanned:1,expired:1,retryPending:0,results:[{sessionId:session.id,status:"expired",providerAbort:"aborted"}],at:"2026-11-17T12:00:00.000Z"});
 assert.deepEqual(f.calls.map(call=>call[0]),["claim","abort","finalize"]);
 assert.equal(f.calls[2][1].expired,true);
 assert.equal(f.events[0].type,"b2.multipart.cleanup");
});

test("treats an already-absent provider upload as successfully cleaned",async()=>{
 const f=fixture({abortError:Object.assign(new Error("missing upload"),{status:404,code:"B2_STORAGE_HTTP_404"})});
 const result=await f.worker.runCycle();
 assert.equal(result.expired,1);
 assert.equal(result.results[0].providerAbort,"already_absent");
 assert.equal(f.calls.at(-1)[0],"finalize");
});

test("keeps provider failures pending for a later leased retry",async()=>{
 const f=fixture({abortError:Object.assign(new Error("temporary provider outage"),{status:503,code:"B2_STORAGE_HTTP_503"})});
 const result=await f.worker.runCycle();
 assert.equal(result.expired,0);
 assert.equal(result.retryPending,1);
 assert.equal(result.results[0].errorCode,"B2_STORAGE_HTTP_503");
 assert.equal(f.calls.some(call=>call[0]==="finalize"),false);
});

test("reports a lost finalization claim rather than falsely reporting cleanup success",async()=>{
 const f=fixture({finalize:false});
 const result=await f.worker.runCycle();
 assert.equal(result.expired,0);
 assert.equal(result.retryPending,1);
 assert.equal(result.results[0].errorCode,"B2_MULTIPART_CLEANUP_STATE_CONFLICT");
});

test("rejects unsafe cleanup limits and missing provider or ledger dependencies",()=>{
 assert.throws(()=>createB2MultipartCleanupWorker({store:{},storage:{}}),/durable session ledger/);
 assert.throws(()=>createB2MultipartCleanupWorker({store:{claimExpiredSessions(){},markAborted(){}},storage:{}}),/B2 abort adapter/);
 assert.throws(()=>createB2MultipartCleanupWorker({store:{claimExpiredSessions(){},markAborted(){}},storage:{abortMultipartUpload(){}},limit:101}),/batch limit/);
});
