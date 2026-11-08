import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Builder, Context, LocalSigner, Reader } from "@contentauth/c2pa-node";
import { createC2paVerifier } from "../c2pa-verification.mjs";
import { createC2paTransformationPreserver } from "../c2pa-transformation-preserver.mjs";

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
