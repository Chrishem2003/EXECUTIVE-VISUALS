import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createC2paTransformationPreserver } from "../c2pa-transformation-preserver.mjs";

const validStore={active_manifest:"active",validation_state:"Valid",manifests:{active:{title:"Signed source",ingredients:[]}}};
function fakeSdk({signAsync}={}){
 class Context{}
 const Reader={async fromAsset(){return{isEmbedded:()=>true,remoteUrl:()=>null,json:()=>validStore};}};
 const Builder={async newAsync(){return{
  async addIngredient(){},setIntent(){},addAction(){},
  async signAsync(signer,input,destination){
   if(signAsync)return signAsync(signer,input,destination);
   await writeFile(destination.path,await readFile(input.path));
  }
 };}};
 return{Context,Reader,Builder};
}

test("rejects oversized source assets before loading the native SDK",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ev-c2pa-size-limit-"));
 try{
  const sourcePath=join(dir,"source.png"),outputPath=join(dir,"output.png");
  await writeFile(sourcePath,Buffer.alloc(0));await truncate(sourcePath,2048);await writeFile(outputPath,"output");
  let sdkLoaded=false;
  const preserve=createC2paTransformationPreserver({maxBytes:1024,sdkLoader:async()=>{sdkLoaded=true;return fakeSdk();}});
  await assert.rejects(preserve({sourcePath,sourceMimeType:"image/png",outputPath,outputMimeType:"image/png"}),error=>error.code==="C2PA_TRANSFORM_SIZE_UNSUPPORTED"&&error.status===413);
  assert.equal(sdkLoaded,false,"oversized media must be rejected before native SDK loading");
  assert.equal(await readFile(outputPath,"utf8"),"output");
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("normalizes pre-aborted work to the stable cancellation error",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ev-c2pa-pre-abort-"));
 try{
  const sourcePath=join(dir,"source.png"),outputPath=join(dir,"output.png");
  await writeFile(sourcePath,"source");await writeFile(outputPath,"output");
  const controller=new AbortController();controller.abort();
  let sdkLoaded=false;
  const preserve=createC2paTransformationPreserver({sdkLoader:async()=>{sdkLoaded=true;return fakeSdk();}});
  await assert.rejects(preserve({sourcePath,sourceMimeType:"image/png",outputPath,outputMimeType:"image/png",signal:controller.signal}),error=>error.code==="C2PA_TRANSFORM_ABORTED"&&error.status===499);
  assert.equal(sdkLoaded,false);
  assert.equal(await readFile(outputPath,"utf8"),"output");
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("cancellation during callback signing never replaces or publishes the derivative",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ev-c2pa-sign-cancel-"));
 try{
  const sourcePath=join(dir,"source.png"),outputPath=join(dir,"output.png");
  const original=Buffer.from("original derivative bytes");
  await writeFile(sourcePath,"signed source bytes");await writeFile(outputPath,original);
  const controller=new AbortController();
  const signer={async sign(){controller.abort();}};
  const sdk=fakeSdk({signAsync:async(_signer,input,destination)=>{
   await signer.sign();
   await writeFile(destination.path,await readFile(input.path));
  }});
  const preserve=createC2paTransformationPreserver({sdkLoader:async()=>sdk});
  await assert.rejects(preserve({
   sourcePath,sourceMimeType:"image/png",outputPath,outputMimeType:"image/png",
   signer,signerMode:"callback",signal:controller.signal,operation:"test:cancel"
  }),error=>error.code==="C2PA_TRANSFORM_ABORTED"&&error.status===499);
  assert.deepEqual(await readFile(outputPath),original,"cancelled signing must leave the original derivative untouched");
  const leftovers=(await readdir(dir)).filter(name=>name.endsWith(".c2pa-tmp"));
  assert.deepEqual(leftovers,[],"temporary signed output must be cleaned up after cancellation");
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("cancellation interrupts a streaming checksum before native parsing",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ev-c2pa-hash-cancel-"));
 try{
  const sourcePath=join(dir,"large-source.bin"),outputPath=join(dir,"output.png");
  await writeFile(sourcePath,Buffer.alloc(0));await truncate(sourcePath,96*1024*1024);await writeFile(outputPath,"output");
  const controller=new AbortController();
  setTimeout(()=>controller.abort(),1);
  let sdkLoaded=false;
  const preserve=createC2paTransformationPreserver({maxBytes:128*1024*1024,sdkLoader:async()=>{sdkLoaded=true;return fakeSdk();}});
  await assert.rejects(preserve({sourcePath,sourceMimeType:"image/png",outputPath,outputMimeType:"image/png",signal:controller.signal}),error=>error.code==="C2PA_TRANSFORM_ABORTED"&&error.status===499);
  assert.equal(sdkLoaded,false,"native parsing must not start after hashing is cancelled");
  assert.equal((await stat(outputPath)).size,6);
 }finally{await rm(dir,{recursive:true,force:true});}
});
