import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, utimes, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWaveformCache } from "../waveform-cache.mjs";

const id="123e4567-e89b-42d3-a456-426614174000";
const sha="a".repeat(64);
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from("waveform-png-test")]);
async function fixture(render){
 const root=await mkdtemp(join(tmpdir(),"ev-waveform-"));
 await mkdir(join(root,"uploads"),{recursive:true});
 const source=join(root,"uploads","audio.wav");await writeFile(source,Buffer.from("source"));
 const asset={id,sha256:sha,media_type:"audio/wav",byte_size:6,storage_path:"uploads/audio.wav"};
 const cache=createWaveformCache({mediaRoot:root,render:render||(async({outputPath})=>writeFile(outputPath,png))});
 return{root,source,asset,cache,close:()=>rm(root,{recursive:true,force:true})};
}

test("generates and reuses a content-addressed waveform derivative",async()=>{
 const f=await fixture();try{
  const first=await f.cache.get(f.asset),second=await f.cache.get(f.asset);
  assert.equal(first,second);
  assert.deepEqual((await readFile(first)).subarray(0,8),png.subarray(0,8));
 }finally{await f.close();}
});

test("deduplicates concurrent waveform generation for the same source revision",async()=>{
 let calls=0,release;
 const gate=new Promise(resolve=>release=resolve);
 const f=await fixture(async({outputPath})=>{calls++;await gate;await writeFile(outputPath,png);});
 try{
  const a=f.cache.get(f.asset),b=f.cache.get(f.asset);
  await new Promise(resolve=>setImmediate(resolve));release();
  assert.equal(await a,await b);assert.equal(calls,1);
 }finally{await f.close();}
});

test("invalidates the derivative key when the source content hash changes",async()=>{
 const f=await fixture();try{
  const first=await f.cache.get(f.asset);
  const second=await f.cache.get({...f.asset,sha256:"b".repeat(64)});
  assert.notEqual(first,second);
 }finally{await f.close();}
});

test("rejects unsupported media, malformed hashes and paths outside managed storage",async()=>{
 const f=await fixture();try{
  await assert.rejects(()=>f.cache.get({...f.asset,media_type:"video/mp4"}),e=>e.code==="WAVEFORM_UNSUPPORTED_MEDIA");
  await assert.rejects(()=>f.cache.get({...f.asset,sha256:"bad"}),e=>e.code==="WAVEFORM_INVALID_ASSET");
  await assert.rejects(()=>f.cache.get({...f.asset,storage_path:"../outside.wav"}),e=>e.code==="WAVEFORM_INVALID_PATH");
 }finally{await f.close();}
});

test("rejects oversized sources and malformed renderer output",async()=>{
 const f=await fixture(async({outputPath})=>writeFile(outputPath,Buffer.from("not png")));
 try{
  await assert.rejects(()=>f.cache.get({...f.asset,byte_size:300*1024*1024}),e=>e.code==="WAVEFORM_SIZE_LIMIT");
  await assert.rejects(()=>f.cache.get(f.asset),e=>e.code==="WAVEFORM_INVALID_OUTPUT");
 }finally{await f.close();}
});

test("FFmpeg produces a real cached waveform PNG from a generated audio fixture",async()=>{
 const ffmpeg=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-version"],{encoding:"utf8",timeout:10000});
 if(ffmpeg.error?.code==="ENOENT"){return;}
 assert.equal(ffmpeg.status,0,ffmpeg.stderr||"Could not generate audio fixture.");
 const root=await mkdtemp(join(tmpdir(),"ev-waveform-ffmpeg-"));
 try{
  await mkdir(join(root,"uploads"),{recursive:true});
  const source=join(root,"uploads","tone.wav");
  const generated=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","sine=frequency=440:duration=1","-c:a","pcm_s16le","-y",source],{encoding:"utf8",timeout:10000});
  assert.equal(generated.status,0,generated.stderr||"Could not generate audio fixture.");
  const {stat}=await import("node:fs/promises");
  const info=await stat(source),bytes=await readFile(source);
  const asset={id,sha256:createHash("sha256").update(bytes).digest("hex"),media_type:"audio/wav",byte_size:info.size,storage_path:"uploads/tone.wav"};
  const cache=createWaveformCache({mediaRoot:root});
  const derivative=await cache.get(asset);
  const pngBytes=await readFile(derivative);
  assert.deepEqual(pngBytes.subarray(0,8),png.subarray(0,8));
  assert.ok(pngBytes.length>100);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("prunes least-recently-used waveform derivatives when the cache exceeds its byte budget",async()=>{
 const f=await fixture(),cache=createWaveformCache({mediaRoot:f.root,maxCacheBytes:png.length,render:async({outputPath})=>writeFile(outputPath,png)});
 try{
  const first=await cache.get(f.asset),second=await cache.get({...f.asset,sha256:"c".repeat(64)});
  await assert.rejects(()=>readFile(first),{code:"ENOENT"});
  assert.deepEqual((await readFile(second)).subarray(0,8),png.subarray(0,8));
  const report=await cache.prune();
  assert.equal(report.bytes,png.length);assert.equal(report.removed,0);
 }finally{await f.close();}
});
test("expires old waveform derivatives and removes stale temporary artifacts",async()=>{
 const f=await fixture(),cache=createWaveformCache({mediaRoot:f.root,maxCacheAgeMs:1000,maxTempAgeMs:1000});
 try{
  await mkdir(cache.cacheRoot,{recursive:true});
  const key=createHash("sha256").update("waveform-v1:"+sha).digest("hex");
  const old=join(cache.cacheRoot,key+".png"),temp=join(cache.cacheRoot,"."+key+".123.deadbeef.tmp.png");
  await writeFile(old,png);await writeFile(temp,png);
  const stale=new Date(Date.now()-5000);await utimes(old,stale,stale);await utimes(temp,stale,stale);
  const report=await cache.prune();
  await assert.rejects(()=>readFile(old),{code:"ENOENT"});
  await assert.rejects(()=>readFile(temp),{code:"ENOENT"});
  assert.equal(report.removed,1);
 }finally{await f.close();}
});

test("rebuilds a corrupted local waveform cache entry",async()=>{
 const f=await fixture(),cache=createWaveformCache({mediaRoot:f.root,render:async({outputPath})=>writeFile(outputPath,png)});
 try{
  const first=await cache.get(f.asset);await writeFile(first,Buffer.from("corrupt-cache"));
  const rebuilt=await cache.get(f.asset);
  assert.equal(first,rebuilt);
  assert.deepEqual((await readFile(rebuilt)).subarray(0,8),png.subarray(0,8));
 }finally{await f.close();}
});


test("rejects a managed-media symlink that resolves outside the media root",async()=>{
 const f=await fixture();
 const outside=await mkdtemp(join(tmpdir(),"ev-waveform-outside-"));
 try{
  const externalSource=join(outside,"outside.wav");
  await writeFile(externalSource,Buffer.from("outside source"));
  await symlink(externalSource,join(f.root,"uploads","linked.wav"));
  await assert.rejects(
   ()=>f.cache.get({...f.asset,storage_path:"uploads/linked.wav"}),
   error=>error.code==="WAVEFORM_INVALID_PATH"
  );
 }finally{
  await f.close();
  await rm(outside,{recursive:true,force:true});
 }
});
