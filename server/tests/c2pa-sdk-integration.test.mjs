import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Builder, CallbackSigner, Context, LocalSigner, Reader } from "@contentauth/c2pa-node";
import { createC2paVerifier } from "../c2pa-verification.mjs";
import { createC2paTransformationPreserver } from "../c2pa-transformation-preserver.mjs";
import { createC2paCallbackSigner } from "../c2pa-callback-signer.mjs";

const here=dirname(fileURLToPath(import.meta.url));
const fixtureRoot=join(here,"fixtures","c2pa");
function crc32(buffer){
 let crc=0xffffffff;
 for(const byte of buffer){
  crc^=byte;
  for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);
 }
 return(crc^0xffffffff)>>>0;
}
function pngChunk(type,data){
 const name=Buffer.from(type),length=Buffer.alloc(4),checksum=Buffer.alloc(4);
 length.writeUInt32BE(data.length);
 checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));
 return Buffer.concat([length,name,data,checksum]);
}
function onePixelPng(red=24,green=48,blue=72){
 const signature=Buffer.from([137,80,78,71,13,10,26,10]);
 const header=Buffer.alloc(13);
 header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);
 header[8]=8;header[9]=6;
 const pixels=deflateSync(Buffer.from([0,red,green,blue,255]));
 return Buffer.concat([signature,pngChunk("IHDR",header),pngChunk("IDAT",pixels),pngChunk("IEND",Buffer.alloc(0))]);
}


test("official CAI SDK signs and validates a real embedded C2PA MP4 video manifest",async()=>{
 const cert=await readFile(join(fixtureRoot,"test-signing-chain.pem"));
 const key=await readFile(join(fixtureRoot,"test-signing-key.pem"));
 const signer=LocalSigner.newSigner(cert,key,"es256");
 const dir=await mkdtemp(join(tmpdir(),"ev-c2pa-video-"));
 const sourcePath=join(dir,"source.mp4"),signedPath=join(dir,"signed.mp4");
 try{
  // Deterministic 32x32, one-frame H.264 MP4 test fixture.
  const video=Buffer.from("AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMObW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAjl0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAGxbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABXG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAARxzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAIABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwAraJbARAAADAAEAAAMAAg8SJqABAAVozgOcgAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABNwAAAAAAAAABhzdHRzAAAAAAAAAAEAAAABAABAAAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAJuAAAAAQAAABRzdGNvAAAAAAAAAAEAAAM+AAAAYXVkdGEAAABZbWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAsaWxzdAAAACSpdG9vAAAAHGRhdGEAAAABAAAAAExhdmY2MS43LjEwMwAAAAhmcmVlAAACdm1kYXQAAAJTBgX//0/cRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MSBkZWJsb2NrPTA6MDowIGFuYWx5c2U9MDowIG1lPWRpYSBzdWJtZT0wIHBzeT0xIHBzeV9yZD0xLjAwOjAuMDAgbWl4ZWRfcmVmPTAgbWVfcmFuZ2U9MTYgY2hyb21hX21lPTEgdHJlbGxpcz0wIDh4OGRjdD0wIGNxbT0wIGRlYWR6b25lPTIxLDExIGZhc3RfcHNraXA9MSBjaHJvbWFfcXBfb2Zmc2V0PTAgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTEgc2NlbmVjdXQ9MCBpbnRyYV9yZWZyZXNoPTAgcmM9Y3JmIG1idHJlZT0wIGNyZj00MC4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTAAgAAAABNliIQ6EYoAAgOxwABAWjgybrde","base64");
  assert.equal(video.length,1452,"video fixture must be a real MP4 container");
  await writeFile(sourcePath,video);
  const builder=await Builder.newAsync();
  builder.setIntent({create:"http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"});
  builder.sign(signer,{path:sourcePath,mimeType:"video/mp4"},{path:signedPath});
  const signed=await readFile(signedPath);
  assert.ok(signed.length>video.length,"signed MP4 must contain an embedded C2PA manifest");
  const sha256=createHash("sha256").update(signed).digest("hex");
  const context=new Context({verify:{verifyAfterReading:true,verifyTrust:true,verifyTimestampTrust:true,ocspFetch:false,remoteManifestFetch:false}});
  const reader=await Reader.fromAsset({path:signedPath,mimeType:"video/mp4"},context);
  assert.equal(reader.isEmbedded(),true);
  const store=reader.json();
  assert.ok(store.active_manifest,"signed video must expose an active manifest");
  assert.ok(["Valid","Trusted"].includes(store.validation_state),JSON.stringify(store.validation_status));
  const verify=await createC2paVerifier({sdkLoader:async()=>({Reader,Context}),maxBytes:1024*1024,trustAnchorsPath:null})({
   filePath:signedPath,mediaType:"video/mp4",expectedSha256:sha256,expectedSize:signed.length
  });
  assert.equal(verify.present,true);
  assert.equal(verify.valid,true);
  assert.ok(["valid_untrusted","trusted"].includes(verify.status));
  assert.equal(verify.assetSha256,sha256);
  const tampered=Buffer.from(signed);
  tampered[tampered.length-1]^=0x01;
  await writeFile(signedPath,tampered);
  const tamperedHash=createHash("sha256").update(tampered).digest("hex");
  const invalid=await createC2paVerifier({sdkLoader:async()=>({Reader,Context}),maxBytes:1024*1024,trustAnchorsPath:null})({
   filePath:signedPath,mediaType:"video/mp4",expectedSha256:tamperedHash,expectedSize:tampered.length
  });
  assert.equal(invalid.present,true);
  assert.equal(invalid.valid,false);
  assert.equal(invalid.trusted,false);
  assert.equal(invalid.status,"invalid");
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("official CAI SDK signs and validates a real embedded C2PA manifest",async()=>{
 const cert=await readFile(join(fixtureRoot,"test-signing-chain.pem"));
 const key=await readFile(join(fixtureRoot,"test-signing-key.pem"));
 const original=onePixelPng();
 const builder=await Builder.newAsync();
 builder.setIntent({create:"http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"});
 const signer=LocalSigner.newSigner(cert,key,"es256");
 const output={buffer:null};
 builder.sign(signer,{buffer:original,mimeType:"image/png"},output);
 assert.ok(Buffer.isBuffer(output.buffer),"CAI SDK must write a signed image buffer");
 assert.ok(output.buffer.length>original.length,"signed image must contain embedded manifest data");

 const reader=await Reader.fromAsset(
  {buffer:output.buffer,mimeType:"image/png"},
  new Context({verify:{verifyAfterReading:true,verifyTrust:true,verifyTimestampTrust:true,ocspFetch:false,remoteManifestFetch:false}})
 );
 assert.equal(reader.isEmbedded(),true);
 const store=reader.json();
 assert.ok(store.active_manifest);
 assert.ok(["Valid","Trusted"].includes(store.validation_state),JSON.stringify(store.validation_status));

 const dir=await mkdtemp(join(tmpdir(),"ev-c2pa-real-manifest-")),filePath=join(dir,"signed.png");
 try{
  await writeFile(filePath,output.buffer);
  const sha256=createHash("sha256").update(output.buffer).digest("hex");
  const verification=await createC2paVerifier({sdkLoader:async()=>({Reader,Context}),maxBytes:1024*1024,trustAnchorsPath:null})({
   filePath,mediaType:"image/png",expectedSha256:sha256,expectedSize:output.buffer.length
  });
  assert.equal(verification.present,true);
  assert.equal(verification.valid,true);
  assert.ok(["valid_untrusted","trusted"].includes(verification.status));
  assert.equal(verification.assetSha256,sha256);
  assert.ok(verification.manifest?.activeManifestLabel);

  const sourcePath=join(dir,"signed-source.png"),outputPath=join(dir,"transformed-output.png");
  await writeFile(sourcePath,output.buffer);
  await writeFile(outputPath,onePixelPng(90,80,70));
  const preserve=createC2paTransformationPreserver({sdkLoader:async()=>({Reader,Builder,Context}),maxBytes:1024*1024});
  const lineage=await preserve({sourcePath,outputPath,sourceMimeType:"image/png",outputMimeType:"image/png",expectedSourceSha256:createHash("sha256").update(output.buffer).digest("hex"),signer,operation:"test:color-adjust"});
  assert.equal(lineage.status,"preserved");
  assert.equal(lineage.preserved,true);
  assert.equal(lineage.ingredientCount,1);
  const transformedReader=await Reader.fromAsset(
   {path:outputPath,mimeType:"image/png"},
   new Context({verify:{verifyAfterReading:true,verifyTrust:true,ocspFetch:false,remoteManifestFetch:false}})
  );
  const transformedStore=transformedReader.json();
  const transformedManifest=transformedStore.manifests[transformedStore.active_manifest];
  assert.ok(transformedManifest.ingredients.some(item=>item.manifest_data),"source C2PA manifest must remain embedded as a transformation ingredient");
  assert.notEqual(transformedStore.validation_state,"Invalid");
  const blockedOutputPath=join(dir,"blocked-output.png");
  await writeFile(blockedOutputPath,onePixelPng(10,20,30));
  const blockedBefore=createHash("sha256").update(await readFile(blockedOutputPath)).digest("hex");
  await assert.rejects(preserve({sourcePath,outputPath:blockedOutputPath,sourceMimeType:"image/png",outputMimeType:"image/png",expectedSourceSha256:createHash("sha256").update(output.buffer).digest("hex"),operation:"test:without-signer"}),error=>error.code==="C2PA_SIGNER_REQUIRED");
  const blockedAfter=createHash("sha256").update(await readFile(blockedOutputPath)).digest("hex");
  assert.equal(blockedAfter,blockedBefore,"missing production signer must not modify or publish C2PA-bearing media");
 }finally{await rm(dir,{recursive:true,force:true});}
});


test("official CAI CallbackSigner delegates C2PA signing to a protected callback",async()=>{
 const cert=await readFile(join(fixtureRoot,"test-signing-chain.pem"));
 const key=await readFile(join(fixtureRoot,"test-signing-key.pem"));
 const testOnlySigner=LocalSigner.newSigner(cert,key,"es256");
 let callbackCalls=0;
 const callbackSigner=await createC2paCallbackSigner({
  sdkLoader:async()=>({CallbackSigner}),algorithm:"es256",certificateChain:[cert],reserveSize:4096,
  sign:async(data,context)=>{
   callbackCalls++;
   assert.equal(context.algorithm,"es256");
   assert.ok(Buffer.isBuffer(data)&&data.length>0);
   return testOnlySigner.sign(data);
  }
 });
 const sourceUnsigned=onePixelPng(22,44,66),signedSource={buffer:null};
 const sourceBuilder=await Builder.newAsync();
 sourceBuilder.setIntent({create:"http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"});
 sourceBuilder.sign(testOnlySigner,{buffer:sourceUnsigned,mimeType:"image/png"},signedSource);
 const dir=await mkdtemp(join(tmpdir(),"ev-c2pa-callback-signer-"));
 try{
  const sourcePath=join(dir,"source.png"),outputPath=join(dir,"derivative.png");
  await writeFile(sourcePath,signedSource.buffer);
  await writeFile(outputPath,onePixelPng(80,60,40));
  const preserve=createC2paTransformationPreserver({sdkLoader:async()=>({Reader,Builder,Context}),maxBytes:1024*1024});
  const result=await preserve({
   sourcePath,sourceMimeType:"image/png",expectedSourceSha256:createHash("sha256").update(signedSource.buffer).digest("hex"),
   outputPath,outputMimeType:"image/png",signer:callbackSigner,signerMode:"callback",operation:"test:protected-callback-sign"
  });
  assert.equal(result.status,"preserved");
  assert.ok(callbackCalls>0,"the CAI SDK must invoke the protected callback signer");
  const reader=await Reader.fromAsset({path:outputPath,mimeType:"image/png"},new Context({verify:{verifyAfterReading:true,verifyTrust:true,ocspFetch:false,remoteManifestFetch:false}}));
  assert.equal(reader.isEmbedded(),true);
  const store=reader.json(),manifest=store.manifests[store.active_manifest];
  assert.ok(["Valid","Trusted"].includes(store.validation_state),JSON.stringify(store.validation_status));
  assert.ok(manifest.ingredients.some(item=>Boolean(item.manifest_data)),"callback-signed output must retain the source ingredient");
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("transformation preservation does not invent a C2PA source lineage when none exists",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"ev-c2pa-no-lineage-"));
 const sourcePath=join(dir,"source.png"),outputPath=join(dir,"output.png");
 try{
  await writeFile(sourcePath,onePixelPng());
  await writeFile(outputPath,onePixelPng(40,50,60));
  const before=createHash("sha256").update(await readFile(outputPath)).digest("hex");
  const preserve=createC2paTransformationPreserver({sdkLoader:async()=>({Reader,Builder,Context}),maxBytes:1024*1024});
  const result=await preserve({sourcePath,outputPath,sourceMimeType:"image/png",outputMimeType:"image/png"});
  const after=createHash("sha256").update(await readFile(outputPath)).digest("hex");
  assert.equal(result.status,"not_present");
  assert.equal(result.preserved,false);
  assert.equal(after,before,"an asset without source C2PA must not be modified");
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("preserves every credential-bearing source in a multi-source transformation",async()=>{
 const cert=await readFile(join(fixtureRoot,"test-signing-chain.pem"));
 const key=await readFile(join(fixtureRoot,"test-signing-key.pem"));
 const signer=LocalSigner.newSigner(cert,key,"es256");
 const dir=await mkdtemp(join(tmpdir(),"ev-c2pa-multi-source-"));
 const sourceA=join(dir,"source-a.png"),sourceB=join(dir,"source-b.png"),outputPath=join(dir,"timeline.mp4");
 try{
  const signSource=async(path,bytes)=>{
   const builder=await Builder.newAsync();
   builder.setIntent({create:"http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"});
   const destination={buffer:null};
   builder.sign(signer,{buffer:bytes,mimeType:"image/png"},destination);
   await writeFile(path,destination.buffer);
   return createHash("sha256").update(destination.buffer).digest("hex");
  };
  const hashA=await signSource(sourceA,onePixelPng(10,20,30));
  const hashB=await signSource(sourceB,onePixelPng(40,50,60));
  await writeFile(outputPath,onePixelPng(70,80,90));
  const preserve=createC2paTransformationPreserver({sdkLoader:async()=>({Reader,Builder,Context}),maxBytes:1024*1024});
  const result=await preserve({
   sources:[{path:sourceA,mediaType:"image/png",sha256:hashA},{path:sourceB,mediaType:"image/png",sha256:hashB}],
   outputPath,outputMimeType:"image/png",signer,operation:"test:multi-source-render"
  });
  assert.equal(result.status,"preserved");
  assert.equal(result.sourceCount,2);
  assert.equal(result.credentialSourceCount,2);
  assert.equal(result.ingredientCount,2);
  const reader=await Reader.fromAsset({path:outputPath,mimeType:"image/png"},new Context({verify:{verifyAfterReading:true,verifyTrust:true,ocspFetch:false,remoteManifestFetch:false}}));
  const manifest=reader.json().manifests[reader.json().active_manifest];
  assert.equal(manifest.ingredients.filter(item=>Boolean(item.manifest_data)).length,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
