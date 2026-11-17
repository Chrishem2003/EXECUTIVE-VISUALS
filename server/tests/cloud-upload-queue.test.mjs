import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CLOUD_UPLOAD_BYTES,
  MAX_CLOUD_UPLOAD_BYTES,
  MAX_CLOUD_UPLOAD_FILES,
  runCloudUploadQueue,
  validateCloudUploadFiles
} from "../../src/platform/cloud-upload-queue.ts";

const file=(name,size=10,type="video/mp4")=>({name,size,type});
const item=(id,name)=>({id,file:file(name),status:"queued"});

test("cloud upload preflight accepts supported media and rejects empty, oversized and unsupported files",()=>{
  const result=validateCloudUploadFiles([
    file("clip.mp4"),
    file("empty.mp4",0),
    file("huge.mp4",MAX_CLOUD_UPLOAD_BYTES+1),
    file("archive.zip",20,"application/zip")
  ]);
  assert.equal(MAX_CLOUD_UPLOAD_BYTES,250*1024*1024);
  assert.equal(DEFAULT_CLOUD_UPLOAD_BYTES,50*1024*1024);
  assert.deepEqual(result.accepted.map(x=>x.name),["clip.mp4"]);
  assert.equal(result.rejected.length,3);
  assert.match(result.rejected[1].reason,/50 MiB/);
});

test("cloud upload preflight expands only when the active provider advertises the larger limit",()=>{
  const large=file("large.mp4",100*1024*1024);
  assert.equal(validateCloudUploadFiles([large]).accepted.length,0);
  assert.equal(validateCloudUploadFiles([large],250*1024*1024).accepted.length,1);
});

test("cloud upload preflight bounds a selection to 50 files without silently dropping overflow",()=>{
  const result=validateCloudUploadFiles(Array.from({length:MAX_CLOUD_UPLOAD_FILES+2},(_,i)=>file("clip-"+i+".mp4")));
  assert.equal(result.accepted.length,MAX_CLOUD_UPLOAD_FILES);
  assert.equal(result.rejected.length,2);
  assert.ok(result.rejected.every(x=>/at most 50/.test(x.reason)));
});

test("cloud upload queue never exceeds its configured concurrency and reports every transition",async()=>{
  const items=Array.from({length:9},(_,i)=>item(String(i),"clip-"+i+".mp4"));
  let active=0,peak=0;
  const updates=[];
  const controller=new AbortController();
  const results=await runCloudUploadQueue(items,async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,4));active--;},{signal:controller.signal,concurrency:2,onUpdate:value=>updates.push(value.status)});
  assert.equal(peak,2);
  assert.ok(results.every(x=>x.status==="succeeded"));
  assert.ok(updates.includes("uploading"));
  assert.equal(updates.filter(x=>x==="succeeded").length,9);
});

test("cloud upload queue reports byte-level progress and final completion",async()=>{
  const updates=[];
  const results=await runCloudUploadQueue([item("1","progress.mp4")],async(value,_signal,onProgress)=>{
    onProgress(value.size/2,value.size);
    onProgress(value.size,value.size);
  },{signal:new AbortController().signal,onUpdate:value=>updates.push(value)});
  assert.equal(results[0].status,"succeeded");
  assert.equal(results[0].progress,100);
  assert.equal(results[0].uploadedBytes,10);
  assert.equal(results[0].totalBytes,10);
  assert.ok(updates.some(value=>value.progress===50));
  assert.equal(updates.at(-1).progress,100);
});

test("a failed upload does not prevent other files from completing",async()=>{
  const items=[item("1","good.mp4"),item("2","bad.mp4"),item("3","also-good.mp4")];
  const results=await runCloudUploadQueue(items,async(value)=>{if(value.name==="bad.mp4")throw new Error("signature rejected");},{signal:new AbortController().signal,concurrency:2});
  assert.deepEqual(results.map(x=>x.status),["succeeded","failed","succeeded"]);
  assert.equal(results[1].error,"signature rejected");
});

test("cancelling the queue marks active and pending uploads cancelled",async()=>{
  const controller=new AbortController();
  const items=[item("1","one.mp4"),item("2","two.mp4"),item("3","three.mp4")];
  const running=runCloudUploadQueue(items,async(_file,signal)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(resolve,100);
    signal.addEventListener("abort",()=>{clearTimeout(timer);reject(new Error("aborted"));},{once:true});
  }),{signal:controller.signal,concurrency:1});
  setTimeout(()=>controller.abort(),5);
  const results=await running;
  assert.deepEqual(results.map(x=>x.status),["cancelled","cancelled","cancelled"]);
});
