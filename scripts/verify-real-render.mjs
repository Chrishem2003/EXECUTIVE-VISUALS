import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/db.mjs";
import { executeMediaJob, executableAvailable } from "../server/media.mjs";

if(!executableAvailable("ffmpeg"))throw new Error("FFmpeg must be installed to run the real render integration test.");
const root=await mkdtemp(join(tmpdir(),"executive-visuals-real-render-"));
const mediaRoot=join(root,"media"),uploads=join(mediaRoot,"uploads"),derived=join(mediaRoot,"derived");
await mkdir(uploads,{recursive:true});await mkdir(derived,{recursive:true});
const source=join(uploads,"source.mp4");
const generated=spawnSync(process.env.FFMPEG_PATH||"ffmpeg",["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc=size=320x240:rate=24","-t","2","-pix_fmt","yuv420p","-c:v","libx264","-preset","ultrafast","-y",source],{encoding:"utf8"});
if(generated.status!==0)throw new Error("Could not create real media fixture: "+generated.stderr);
const db=openDatabase(join(root,"runtime.sqlite"));
try{
 db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("real-user","real-render@example.test");
 db.prepare("INSERT INTO assets(id,owner_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?)")
  .run("real-asset","real-user","source.mp4","video/mp4",(await stat(source)).size,"b".repeat(64),"uploads/source.mp4","{}");
 const timeline={id:"real-timeline",projectId:null,name:"Real render integration",revision:1,frameRate:{numerator:24,denominator:1},width:320,height:240,pixelAspectRatio:1,tracks:[{id:"v1",name:"Video 1",kind:"video",enabled:true,locked:false,clips:[{id:"clip-1",assetId:"real-asset",name:"Test pattern",sourceRange:{start:{value:0,rate:24},duration:{value:48,rate:24}},timelineStart:{value:0,rate:24},duration:{value:48,rate:24},enabled:true}]}],markers:[]};
 db.prepare("INSERT INTO timelines(id,owner_id,project_id,name,timeline_json) VALUES(?,?,?,?,?)").run("real-timeline","real-user",null,timeline.name,JSON.stringify(timeline));
 const job={id:"real-job",owner_id:"real-user",project_id:null,job_type:"timeline.render",input_json:JSON.stringify({timelineId:"real-timeline"})};
 const result=await executeMediaJob({db,job,mediaRoot,activeProcesses:new Map(),onProgress:()=>{}});
 const stored=db.prepare("SELECT * FROM assets WHERE id=?").get(result.outputAsset.id);
 const output=join(mediaRoot,stored.storage_path);
 assert.ok((await stat(output)).size>1000,"rendered master should contain real encoded video data");
 const probe=spawnSync(process.env.FFPROBE_PATH||"ffprobe",["-v","error","-show_entries","stream=codec_name,width,height","-show_entries","format=duration","-of","json",output],{encoding:"utf8"});
 assert.equal(probe.status,0,probe.stderr);
 const metadata=JSON.parse(probe.stdout),video=metadata.streams.find(x=>x.codec_name==="h264");
 assert.ok(video,"master should contain H.264 video");
 assert.equal(video.width,320);assert.equal(video.height,240);
 assert.ok(Number(metadata.format.duration)>1.8&&Number(metadata.format.duration)<2.2);
 console.log("Real FFmpeg integration passed: generated a two-second MP4 master, verified codec, dimensions, duration and persisted derivative.");
}finally{db.close();await rm(root,{recursive:true,force:true});}
