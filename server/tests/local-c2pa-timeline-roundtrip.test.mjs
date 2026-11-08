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
function run(command,args){
 const result=spawnSync(command,args,{encoding:"utf8"});
 if(result.status!==0)throw new Error(command+" failed: "+(result.stderr||result.stdout));
}
const sha256=async path=>createHash("sha256").update(await readFile(path)).digest("hex");
async function signAsset(signer,inputPath,outputPath,mimeType){
 const builder=await Builder.newAsync();
 builder.setIntent({create:"http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture"});
 builder.sign(signer,{path:inputPath,mimeType},{path:outputPath,mimeType});
 return{size:(await stat(outputPath)).size,sha256:await sha256(outputPath)};
}

test("local SQLite timeline render preserves signed video, audio and still-overlay ingredients",async()=>{
 if(!executableAvailable("ffmpeg")||!executableAvailable("ffprobe"))throw new Error("FFmpeg and FFprobe are required for the local C2PA timeline integration test.");
 const root=await mkdtemp(join(tmpdir(),"ev-local-c2pa-timeline-"));
 const mediaRoot=join(root,"media"),uploads=join(mediaRoot,"uploads"),derived=join(mediaRoot,"derived");
 await mkdir(uploads,{recursive:true});await mkdir(derived,{recursive:true});
 const unsignedVideo=join(root,"video.mp4"),unsignedAudio=join(root,"audio.wav"),unsignedOverlay=join(root,"overlay.png");
 const videoPath=join(uploads,"signed-video.mp4"),audioPath=join(uploads,"signed-audio.wav"),overlayPath=join(uploads,"signed-overlay.png");
 const db=openDatabase(join(root,"runtime.sqlite"));
 try{
  run(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:s=320x240:r=24","-t","2","-pix_fmt","yuv420p","-c:v","libx264","-preset","ultrafast","-y",unsignedVideo]);
  run(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","sine=frequency=440:duration=2","-c:a","pcm_s16le","-y",unsignedAudio]);
  run(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=red:s=80x60","-frames:v","1","-y",unsignedOverlay]);
  const cert=await readFile(join(fixtureRoot,"test-signing-chain.pem"));
  const key=await readFile(join(fixtureRoot,"test-signing-key.pem"));
  const signer=LocalSigner.newSigner(cert,key,"es256");
  const video=await signAsset(signer,unsignedVideo,videoPath,"video/mp4");
  const audio=await signAsset(signer,unsignedAudio,audioPath,"audio/wav");
  const overlay=await signAsset(signer,unsignedOverlay,overlayPath,"image/png");

  db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("timeline-c2pa-user","timeline-c2pa@example.test");
  const insertAsset=db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)");
  insertAsset.run("timeline-c2pa-video","timeline-c2pa-user",null,"signed-video.mp4","video/mp4",video.size,video.sha256,"uploads/signed-video.mp4","{}");
  insertAsset.run("timeline-c2pa-audio","timeline-c2pa-user",null,"signed-audio.wav","audio/wav",audio.size,audio.sha256,"uploads/signed-audio.wav","{}");
  insertAsset.run("timeline-c2pa-overlay","timeline-c2pa-user",null,"signed-overlay.png","image/png",overlay.size,overlay.sha256,"uploads/signed-overlay.png","{}");

  const timeline={
   id:"local-c2pa-timeline",projectId:null,name:"C2PA timeline round-trip",revision:1,
   frameRate:{numerator:24,denominator:1},width:320,height:240,pixelAspectRatio:1,
   tracks:[
    {id:"video",name:"Video",kind:"video",enabled:true,locked:false,clips:[{id:"video-clip",assetId:"timeline-c2pa-video",name:"Signed source video",sourceRange:{start:{value:0,rate:24},duration:{value:48,rate:24}},timelineStart:{value:0,rate:24},duration:{value:48,rate:24},enabled:true}]},
    {id:"audio",name:"Audio",kind:"audio",enabled:true,locked:false,clips:[{id:"audio-clip",assetId:"timeline-c2pa-audio",name:"Signed source audio",sourceRange:{start:{value:0,rate:24},duration:{value:48,rate:24}},timelineStart:{value:0,rate:24},duration:{value:48,rate:24},enabled:true}]},
    {id:"overlay",name:"Overlay",kind:"overlay",enabled:true,locked:false,clips:[{id:"overlay-clip",assetId:"timeline-c2pa-overlay",name:"Signed still overlay",sourceRange:{start:{value:0,rate:24},duration:{value:24,rate:24}},timelineStart:{value:24,rate:24},duration:{value:24,rate:24},enabled:true,metadata:{x:10,y:10,width:80,height:60,opacity:1}}]}
   ],markers:[]
  };
  db.prepare("INSERT INTO timelines(id,owner_id,project_id,name,timeline_json) VALUES(?,?,?,?,?)")
   .run("local-c2pa-timeline","timeline-c2pa-user",null,timeline.name,JSON.stringify(timeline));
  const jobInput=JSON.stringify({timelineId:"local-c2pa-timeline"});
  db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,input_json) VALUES(?,?,?,?,?,?)")
   .run("local-c2pa-timeline-job","timeline-c2pa-user",null,"timeline.render","queued",jobInput);

  const result=await executeMediaJob({
   db,mediaRoot,activeProcesses:new Map(),onProgress:()=>{},
   job:{id:"local-c2pa-timeline-job",owner_id:"timeline-c2pa-user",project_id:null,job_type:"timeline.render",input_json:jobInput},
   c2paSigner:signer
  });
  assert.equal(result.c2paPreservation.status,"preserved");
  assert.equal(result.c2paPreservation.sourceCount,3);
  assert.equal(result.c2paPreservation.credentialSourceCount,3);
  assert.equal(result.c2paPreservation.ingredientCount,3);
  const row=db.prepare("SELECT storage_path,byte_size,sha256,metadata_json FROM assets WHERE id=?").get(result.outputAsset.id);
  const publishedPath=join(mediaRoot,row.storage_path);
  assert.ok(row.byte_size>1000);
  assert.equal(row.sha256,await sha256(publishedPath),"timeline output checksum must be computed after signing");
  const reader=await Reader.fromAsset({path:publishedPath,mimeType:"video/mp4"},new Context({verify:{verifyAfterReading:true,verifyTrust:true,ocspFetch:false,remoteManifestFetch:false}}));
  assert.equal(reader.isEmbedded(),true);
  const store=reader.json(),manifest=store.manifests[store.active_manifest];
  assert.ok(["Valid","Trusted"].includes(store.validation_state),JSON.stringify(store.validation_status));
  const ingredients=manifest.ingredients.filter(item=>Boolean(item.manifest_data));
  assert.equal(ingredients.length,3,"signed video, audio and still-image overlay must all remain in the final manifest");
  assert.equal(ingredients[0].relationship,"parentOf");
  assert.ok(ingredients.slice(1).every(item=>item.relationship==="componentOf"));
  const metadata=JSON.parse(row.metadata_json);
  assert.equal(metadata.c2paPreservation.status,"preserved");
  assert.equal(metadata.c2paPreservation.outputSha256,row.sha256);
 }finally{
  db.close();
  await rm(root,{recursive:true,force:true});
 }
});
