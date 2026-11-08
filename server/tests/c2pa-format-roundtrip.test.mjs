import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Builder, Context, LocalSigner, Reader } from "@contentauth/c2pa-node";
import { createC2paTransformationPreserver } from "../c2pa-transformation-preserver.mjs";

const here=dirname(fileURLToPath(import.meta.url));
const fixtureRoot=join(here,"fixtures","c2pa");
const formats=[
 {extension:"jpg",mimeType:"image/jpeg",kind:"image"},
 {extension:"png",mimeType:"image/png",kind:"image"},
 {extension:"webp",mimeType:"image/webp",kind:"image"},
 {extension:"gif",mimeType:"image/gif",kind:"image"},
 {extension:"mp3",mimeType:"audio/mpeg",kind:"audio"},
 {extension:"wav",mimeType:"audio/wav",kind:"audio"},
 {extension:"m4a",mimeType:"audio/mp4",kind:"audio"},
 {extension:"mp4",mimeType:"video/mp4",kind:"video"},
 {extension:"mov",mimeType:"video/quicktime",kind:"video"}
];
function run(args){
 const result=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",args,{encoding:"utf8"});
 if(result.status!==0)throw new Error("FFmpeg fixture generation failed: "+(result.stderr||result.stdout));
}
function generate(path,format,color){
 if(format.kind==="image"){
  const codec=format.extension==="jpg"?["-c:v","mjpeg"]:format.extension==="webp"?["-c:v","libwebp"]:[];
  run(["-hide_banner","-loglevel","error","-f","lavfi","-i",`color=c=${color}:s=64x64`,"-frames:v","1",...codec,"-y",path]);
 }else if(format.kind==="audio"){
  const codec=format.extension==="mp3"?["-c:a","libmp3lame","-q:a","5"]:format.extension==="m4a"?["-c:a","aac","-b:a","96k"]:["-c:a","pcm_s16le"];
  run(["-hide_banner","-loglevel","error","-f","lavfi","-i","sine=frequency=440:duration=0.6",...codec,"-y",path]);
 }else{
  run(["-hide_banner","-loglevel","error","-f","lavfi","-i",`color=c=${color}:s=64x64:r=24`,"-t","1","-pix_fmt","yuv420p","-c:v","libx264","-preset","ultrafast","-y",path]);
 }
}
const sha256=async path=>createHash("sha256").update(await readFile(path)).digest("hex");

test("official CAI SDK preserves embedded source credentials across every application media format",async t=>{
 const cert=await readFile(join(fixtureRoot,"test-signing-chain.pem"));
 const key=await readFile(join(fixtureRoot,"test-signing-key.pem"));
 const signer=LocalSigner.newSigner(cert,key,"es256");
 const preserve=createC2paTransformationPreserver({maxBytes:10*1024*1024});
 const root=await mkdtemp(join(tmpdir(),"ev-c2pa-format-matrix-"));
 await mkdir(root,{recursive:true});
 try{
  for(const format of formats){
   await t.test(format.extension,async()=>{
    const sourceUnsigned=join(root,"source-unsigned."+format.extension);
    const sourceSigned=join(root,"source-signed."+format.extension);
    const outputPath=join(root,"derivative."+format.extension);
    generate(sourceUnsigned,format,"blue");
    generate(outputPath,format,"green");
    const builder=await Builder.newAsync();
    builder.setIntent({create:"http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"});
    builder.sign(signer,{path:sourceUnsigned,mimeType:format.mimeType},{path:sourceSigned,mimeType:format.mimeType});
    const sourceHash=await sha256(sourceSigned);
    const sourceReader=await Reader.fromAsset({path:sourceSigned,mimeType:format.mimeType},new Context({verify:{verifyAfterReading:true,verifyTrust:true,ocspFetch:false,remoteManifestFetch:false}}));
    assert.equal(sourceReader.isEmbedded(),true);
    assert.ok(["Valid","Trusted"].includes(sourceReader.json().validation_state));

    const result=await preserve({
     sourcePath:sourceSigned,sourceMimeType:format.mimeType,expectedSourceSha256:sourceHash,
     outputPath,outputMimeType:format.mimeType,signer,operation:"test:format-roundtrip:"+format.extension
    });
    assert.equal(result.status,"preserved");
    assert.equal(result.credentialSourceCount,1);
    assert.equal(result.outputSha256,await sha256(outputPath));
    const reader=await Reader.fromAsset({path:outputPath,mimeType:format.mimeType},new Context({verify:{verifyAfterReading:true,verifyTrust:true,ocspFetch:false,remoteManifestFetch:false}}));
    assert.equal(reader.isEmbedded(),true);
    const store=reader.json();
    assert.ok(["Valid","Trusted"].includes(store.validation_state),JSON.stringify(store.validation_status));
    const manifest=store.manifests[store.active_manifest];
    assert.ok(manifest.ingredients.some(item=>Boolean(item.manifest_data)),"signed source ingredient must remain embedded after "+format.extension+" transformation");
   });
  }
 }finally{
  await rm(root,{recursive:true,force:true});
 }
});
