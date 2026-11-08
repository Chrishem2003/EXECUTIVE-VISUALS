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
import { executeMediaJob } from "../media.mjs";

const here=dirname(fileURLToPath(import.meta.url));
const fixtureRoot=join(here,"fixtures","c2pa");
function run(args){
 const result=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",args,{encoding:"utf8"});
 if(result.status!==0)throw new Error("FFmpeg fixture operation failed: "+(result.stderr||result.stdout));
}
const sha256=async path=>createHash("sha256").update(await readFile(path)).digest("hex");

test("local SQLite AI-upscale executor preserves a signed image through derivative publication",async()=>{
 const root=await mkdtemp(join(tmpdir(),"ev-local-c2pa-ai-upscale-"));
 const mediaRoot=join(root,"media"),uploads=join(mediaRoot,"uploads"),derived=join(mediaRoot,"derived");
 await mkdir(uploads,{recursive:true});await mkdir(derived,{recursive:true});
 const unsignedPath=join(root,"source.png"),sourcePath=join(uploads,"signed-source.png");
 const db=openDatabase(join(root,"runtime.sqlite"));
 try{
  run(["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:s=32x32","-frames:v","1","-y",unsignedPath]);
  const cert=await readFile(join(fixtureRoot,"test-signing-chain.pem"));
  const key=await readFile(join(fixtureRoot,"test-signing-key.pem"));
  const signer=LocalSigner.newSigner(cert,key,"es256");
  const builder=await Builder.newAsync();
  builder.setIntent({create:"http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"});
  builder.sign(signer,{path:unsignedPath,mimeType:"image/png"},{path:sourcePath,mimeType:"image/png"});
  const sourceInfo=await stat(sourcePath),sourceSha256=await sha256(sourcePath);

  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("ai-c2pa-user","ai-c2pa@example.test");
  db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)")
   .run("ai-c2pa-source","ai-c2pa-user",null,"signed-source.png","image/png",sourceInfo.size,sourceSha256,"uploads/signed-source.png","{}");
  const jobInput=JSON.stringify({sourceAssetId:"ai-c2pa-source",format:"png",model:"test-only-fixture",scale:4,tile:0});
  db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,input_json) VALUES(?,?,?,?,?,?)")
   .run("ai-c2pa-upscale","ai-c2pa-user",null,"media.ai-upscale","queued",jobInput);

  const result=await executeMediaJob({
   db,mediaRoot,activeProcesses:new Map(),onProgress:()=>{},
   job:{id:"ai-c2pa-upscale",owner_id:"ai-c2pa-user",project_id:null,job_type:"media.ai-upscale",input_json:jobInput},
   c2paSigner:signer,
   aiUpscalerFactory:()=>({execute:async({inputPath,outputPath,signal,model,scale,tile})=>{
    assert.ok(signal instanceof AbortSignal);
    run(["-hide_banner","-loglevel","error","-i",inputPath,"-vf","scale=128:128:flags=lanczos","-frames:v","1","-y",outputPath]);
    return{engine:"test-only-upscaler",method:"deterministic-lanczos-fixture",model,scale,tile};
   }})
  });
  assert.equal(result.c2paPreservation.status,"preserved");
  assert.equal(result.c2paPreservation.credentialSourceCount,1);
  assert.equal(result.processing.engine,"test-only-upscaler");
  const row=db.prepare("SELECT storage_path,byte_size,sha256,metadata_json,derivative_of FROM assets WHERE id=?").get(result.outputAsset.id);
  const publishedPath=join(mediaRoot,row.storage_path);
  assert.equal(row.derivative_of,"ai-c2pa-source");
  assert.equal(row.sha256,await sha256(publishedPath),"AI-upscale derivative checksum must be calculated after C2PA signing");
  const reader=await Reader.fromAsset({path:publishedPath,mimeType:"image/png"},new Context({verify:{verifyAfterReading:true,verifyTrust:true,ocspFetch:false,remoteManifestFetch:false}}));
  assert.equal(reader.isEmbedded(),true);
  const store=reader.json(),manifest=store.manifests[store.active_manifest];
  assert.ok(["Valid","Trusted"].includes(store.validation_state),JSON.stringify(store.validation_status));
  assert.ok(manifest.ingredients.some(item=>Boolean(item.manifest_data)),"the signed source image must remain embedded as an ingredient");
  const metadata=JSON.parse(row.metadata_json);
  assert.equal(metadata.c2paPreservation.status,"preserved");
  assert.equal(metadata.processing.engine,"test-only-upscaler");
 }finally{
  db.close();
  await rm(root,{recursive:true,force:true});
 }
});
