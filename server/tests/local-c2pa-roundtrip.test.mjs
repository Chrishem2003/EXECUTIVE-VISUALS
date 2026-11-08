import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Builder, Context, LocalSigner, Reader } from "@contentauth/c2pa-node";
import { openDatabase } from "../db.mjs";
import { executeMediaJob, executableAvailable } from "../media.mjs";

const here=dirname(fileURLToPath(import.meta.url));
const fixtureRoot=join(here,"fixtures","c2pa");
const hashFile=async path=>createHash("sha256").update(await readFile(path)).digest("hex");
const run=(command,args)=>{
 const result=spawnSync(command,args,{encoding:"utf8"});
 if(result.status!==0)throw new Error(command+" failed: "+(result.stderr||result.stdout));
 return result;
};

test("local SQLite media transcode preserves a real CAI-signed source through publication",async()=>{
 if(!executableAvailable("ffmpeg")||!executableAvailable("ffprobe"))throw new Error("FFmpeg and FFprobe are required for the local C2PA round-trip integration test.");
 const root=await mkdtemp(join(tmpdir(),"ev-local-c2pa-roundtrip-"));
 const mediaRoot=join(root,"media"),uploads=join(mediaRoot,"uploads"),derived=join(mediaRoot,"derived");
 await mkdir(uploads,{recursive:true});await mkdir(derived,{recursive:true});
 const unsignedPath=join(root,"unsigned.mp4"),sourcePath=join(uploads,"signed-source.mp4");
 const db=openDatabase(join(root,"runtime.sqlite"));
 try{
  run(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:s=320x240:r=24","-t","2","-pix_fmt","yuv420p","-c:v","libx264","-preset","ultrafast","-y",unsignedPath]);
  const cert=await readFile(join(fixtureRoot,"test-signing-chain.pem"));
  const key=await readFile(join(fixtureRoot,"test-signing-key.pem"));
  const signer=LocalSigner.newSigner(cert,key,"es256");
  const builder=await Builder.newAsync();
  builder.setIntent({create:"http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"});
  builder.sign(signer,{path:unsignedPath,mimeType:"video/mp4"},{path:sourcePath,mimeType:"video/mp4"});
  const sourceInfo=await stat(sourcePath),sourceSha256=await hashFile(sourcePath);
  const sourceReader=await Reader.fromAsset({path:sourcePath,mimeType:"video/mp4"},new Context({verify:{verifyAfterReading:true,verifyTrust:true,ocspFetch:false,remoteManifestFetch:false}}));
  assert.equal(sourceReader.isEmbedded(),true);
  assert.ok(["Valid","Trusted"].includes(sourceReader.json().validation_state),"source fixture must have a valid embedded C2PA manifest");

  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("local-c2pa-user","local-c2pa@example.test");
  db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)")
   .run("local-c2pa-source","local-c2pa-user",null,"signed-source.mp4","video/mp4",sourceInfo.size,sourceSha256,"uploads/signed-source.mp4","{}");

  const result=await executeMediaJob({
   db,mediaRoot,activeProcesses:new Map(),onProgress:()=>{},
   job:{id:"local-c2pa-transcode",owner_id:"local-c2pa-user",project_id:null,job_type:"media.transcode",input_json:JSON.stringify({sourceAssetId:"local-c2pa-source",container:"mp4",videoCodec:"libx264",audioCodec:"aac",preset:"ultrafast"})},
   c2paSigner:signer
  });
  assert.equal(result.c2paPreservation.status,"preserved");
  assert.equal(result.c2paPreservation.credentialSourceCount,1);
  assert.ok(result.outputAsset?.id);
  const row=db.prepare("SELECT storage_path,byte_size,sha256,metadata_json FROM assets WHERE id=?").get(result.outputAsset.id);
  const publishedPath=join(mediaRoot,row.storage_path);
  const publishedInfo=await stat(publishedPath);
  assert.equal(row.byte_size,publishedInfo.size);
  assert.equal(row.sha256,await hashFile(publishedPath),"published SHA-256 must be computed after C2PA signing");

  const publishedReader=await Reader.fromAsset({path:publishedPath,mimeType:"video/mp4"},new Context({verify:{verifyAfterReading:true,verifyTrust:true,ocspFetch:false,remoteManifestFetch:false}}));
  assert.equal(publishedReader.isEmbedded(),true);
  const store=publishedReader.json();
  assert.ok(["Valid","Trusted"].includes(store.validation_state),JSON.stringify(store.validation_status));
  const manifest=store.manifests[store.active_manifest];
  assert.ok(manifest.ingredients.some(item=>Boolean(item.manifest_data)),"the published local derivative must embed its signed source manifest as an ingredient");
  const metadata=JSON.parse(row.metadata_json);
  assert.equal(metadata.c2paPreservation.status,"preserved");
  assert.equal(metadata.c2paPreservation.outputSha256,row.sha256);
 }finally{
  db.close();
  await rm(root,{recursive:true,force:true});
 }
});
