import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/db.mjs";
import { executeMediaJob, executableAvailable } from "../server/media.mjs";

if(!executableAvailable("ffmpeg"))throw new Error("FFmpeg must be installed to run the real render integration test.");
const root=await mkdtemp(join(tmpdir(),"executive-visuals-real-render-"));
const mediaRoot=join(root,"media"),uploads=join(mediaRoot,"uploads"),derived=join(mediaRoot,"derived");
await mkdir(uploads,{recursive:true});await mkdir(derived,{recursive:true});
const source=join(uploads,"source.mp4"),audio=join(uploads,"music.wav"),overlay=join(uploads,"overlay.png"),captions=join(uploads,"captions.srt"),vtt=join(uploads,"captions.vtt");
const generated=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=blue:s=320x240:r=24","-t","2","-pix_fmt","yuv420p","-c:v","libx264","-preset","ultrafast","-y",source],{encoding:"utf8"});
if(generated.status!==0)throw new Error("Could not create real media fixture: "+generated.stderr);
const audioGenerated=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","sine=frequency=440:duration=2","-c:a","pcm_s16le","-y",audio],{encoding:"utf8"});
if(audioGenerated.status!==0)throw new Error("Could not create audio fixture: "+audioGenerated.stderr);
const overlayGenerated=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","color=c=red:s=80x60","-frames:v","1","-y",overlay],{encoding:"utf8"});
if(overlayGenerated.status!==0)throw new Error("Could not create overlay fixture: "+overlayGenerated.stderr);
await writeFile(captions,"1\n00:00:00,500 --> 00:00:01,500\nHELLO WORLD\n","utf8");
await writeFile(vtt,"WEBVTT\n\n00:00:01.500 --> 00:00:01.900\nWEBVTT CAPTION\n","utf8");
const db=openDatabase(join(root,"runtime.sqlite"));
try{
 db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("real-user","real-render@example.test");
 db.prepare("INSERT INTO assets(id,owner_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?)")
  .run("real-asset","real-user","source.mp4","video/mp4",(await stat(source)).size,"b".repeat(64),"uploads/source.mp4","{}");
 db.prepare("INSERT INTO assets(id,owner_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?)")
  .run("real-audio","real-user","music.wav","audio/wav",(await stat(audio)).size,"c".repeat(64),"uploads/music.wav","{}");
 db.prepare("INSERT INTO assets(id,owner_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?)")
  .run("real-overlay","real-user","overlay.png","image/png",(await stat(overlay)).size,"d".repeat(64),"uploads/overlay.png","{}");
 db.prepare("INSERT INTO assets(id,owner_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?)")
  .run("real-captions","real-user","captions.srt","text/plain",(await stat(captions)).size,"e".repeat(64),"uploads/captions.srt","{}");
 db.prepare("INSERT INTO assets(id,owner_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?)")
  .run("real-vtt","real-user","captions.vtt","text/vtt",(await stat(vtt)).size,"f".repeat(64),"uploads/captions.vtt","{}");
 const timeline={id:"real-timeline",projectId:null,name:"Real render integration",revision:1,frameRate:{numerator:24,denominator:1},width:320,height:240,pixelAspectRatio:1,tracks:[{id:"v1",name:"Video 1",kind:"video",enabled:true,locked:false,clips:[{id:"clip-1",assetId:"real-asset",name:"Test pattern",sourceRange:{start:{value:0,rate:24},duration:{value:48,rate:24}},timelineStart:{value:0,rate:24},duration:{value:48,rate:24},enabled:true}]},{id:"a1",name:"Music",kind:"audio",enabled:true,locked:false,clips:[{id:"audio-clip",assetId:"real-audio",name:"Sine tone",sourceRange:{start:{value:0,rate:24},duration:{value:48,rate:24}},timelineStart:{value:0,rate:24},duration:{value:48,rate:24},enabled:true}]},{id:"o1",name:"Overlay",kind:"overlay",enabled:true,locked:false,clips:[{id:"overlay-clip",assetId:"real-overlay",name:"Red overlay",sourceRange:{start:{value:0,rate:24},duration:{value:24,rate:24}},timelineStart:{value:24,rate:24},duration:{value:24,rate:24},enabled:true,metadata:{x:10,y:10,width:80,height:60,opacity:1}}]},{id:"c1",name:"Captions",kind:"caption",enabled:true,locked:false,clips:[{id:"caption-clip",assetId:"real-captions",name:"Subtitle",sourceRange:{start:{value:0,rate:24},duration:{value:48,rate:24}},timelineStart:{value:0,rate:24},duration:{value:48,rate:24},enabled:true,metadata:{fontSize:28,alignment:2,marginV:30}}]},{id:"c2",name:"WebVTT",kind:"caption",enabled:true,locked:false,clips:[{id:"vtt-clip",assetId:"real-vtt",name:"WebVTT subtitle",sourceRange:{start:{value:0,rate:24},duration:{value:48,rate:24}},timelineStart:{value:0,rate:24},duration:{value:48,rate:24},enabled:true,metadata:{fontSize:28,alignment:2,marginV:30}}]}],markers:[]};
 db.prepare("INSERT INTO timelines(id,owner_id,project_id,name,timeline_json) VALUES(?,?,?,?,?)").run("real-timeline","real-user",null,timeline.name,JSON.stringify(timeline));
 const job={id:"real-job",owner_id:"real-user",project_id:null,job_type:"timeline.render",input_json:JSON.stringify({timelineId:"real-timeline"})};
 const result=await executeMediaJob({db,job,mediaRoot,activeProcesses:new Map(),onProgress:()=>{}});
 const stored=db.prepare("SELECT * FROM assets WHERE id=?").get(result.outputAsset.id);
 const output=join(mediaRoot,stored.storage_path);
 assert.ok((await stat(output)).size>1000,"rendered master should contain real encoded video data");
 const probe=spawnSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","stream=codec_name,width,height","-show_entries","format=duration","-of","json",output],{encoding:"utf8"});
 assert.equal(probe.status,0,probe.stderr);
 const metadata=JSON.parse(probe.stdout),video=metadata.streams.find(x=>x.codec_name==="h264"),audioStream=metadata.streams.find(x=>x.codec_name==="aac");
 assert.ok(video,"master should contain H.264 video");
 assert.ok(audioStream,"master should contain AAC audio");
 const frame=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-ss","1.1","-i",output,"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","-"],{encoding:"buffer",maxBuffer:4*1024*1024});
 assert.equal(frame.status,0,frame.stderr?.toString());
 const pixels=frame.stdout,redIndex=(20*320+20)*3;
 assert.ok(pixels[redIndex]>180&&pixels[redIndex+1]<90&&pixels[redIndex+2]<90,"image overlay should render at its configured position");
 let whiteCaptionPixels=0;
 for(let y=170;y<230;y++)for(let x=50;x<270;x++){const p=(y*320+x)*3;if(pixels[p]>210&&pixels[p+1]>210&&pixels[p+2]>210)whiteCaptionPixels++;}
 assert.ok(whiteCaptionPixels>20,"timed subtitle text should be burned into the video frame");
 const vttFrame=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-ss","1.7","-i",output,"-frames:v","1","-f","rawvideo","-pix_fmt","rgb24","-"],{encoding:"buffer",maxBuffer:4*1024*1024});
 assert.equal(vttFrame.status,0,vttFrame.stderr?.toString());
 let vttWhitePixels=0;
 for(let y=170;y<230;y++)for(let x=50;x<270;x++){const p=(y*320+x)*3;if(vttFrame.stdout[p]>210&&vttFrame.stdout[p+1]>210&&vttFrame.stdout[p+2]>210)vttWhitePixels++;}
 assert.ok(vttWhitePixels>20,"timed WebVTT text should also be burned into the video frame");
 assert.equal(video.width,320);assert.equal(video.height,240);
 assert.ok(Number(metadata.format.duration)>1.8&&Number(metadata.format.duration)<2.2);
 console.log("Real FFmpeg integration passed: H.264/AAC master render, dimensions, duration, image overlay placement, SRT captions and WebVTT captions verified.");
}finally{db.close();await rm(root,{recursive:true,force:true});}
