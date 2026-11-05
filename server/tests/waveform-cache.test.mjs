import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
