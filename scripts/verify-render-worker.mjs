import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../server/db.mjs";
import { executeMediaJob } from "../server/media.mjs";

const root=await mkdtemp(join(tmpdir(),"executive-visuals-render-"));
const mediaRoot=join(root,"media"),uploads=join(mediaRoot,"uploads"),derived=join(mediaRoot,"derived");
await mkdir(uploads,{recursive:true});await mkdir(derived,{recursive:true});
const source=join(uploads,"source.mp4");
await writeFile(source,Buffer.from([0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,0,1]));
const capture=join(root,"ffmpeg-args.txt");
const stub=join(root,"ffmpeg-stub.sh");
await writeFile(stub,'#!/bin/sh\nif [ "$1" = "-version" ]; then echo "ffmpeg test stub"; exit 0; fi\nprintf "%s\\n" "$@" > "$FFMPEG_CAPTURE"\nfor arg in "$@"; do last="$arg"; done\nprintf "test-mp4-output" > "$last"\n');
await chmod(stub,0o755);
const oldPath=process.env.FFMPEG_PATH,oldCapture=process.env.FFMPEG_CAPTURE;
process.env.FFMPEG_PATH=stub;process.env.FFMPEG_CAPTURE=capture;
const db=openDatabase(join(root,"runtime.sqlite"));
try{
 db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run("user-1","render@example.test");
 db.prepare("INSERT INTO assets(id,owner_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?)")
   .run("asset-1","user-1","source.mp4","video/mp4",(await stat(source)).size,"a".repeat(64),"uploads/source.mp4","{}");
 const timeline={
  id:"timeline-1",projectId:null,name:"Render test",revision:1,frameRate:{numerator:24,denominator:1},width:1280,height:720,pixelAspectRatio:1,
  tracks:[{id:"video-1",name:"Video 1",kind:"video",enabled:true,locked:false,clips:[
   {id:"clip-1",assetId:"asset-1",name:"Source",sourceRange:{start:{value:0,rate:24},duration:{value:48,rate:24}},timelineStart:{value:0,rate:24},duration:{value:48,rate:24},enabled:true}
  ]}],markers:[]
 };
 db.prepare("INSERT INTO timelines(id,owner_id,project_id,name,timeline_json) VALUES(?,?,?,?,?)")
   .run("timeline-1","user-1",null,"Render test",JSON.stringify(timeline));
 const job={id:"job-1",owner_id:"user-1",project_id:null,job_type:"timeline.render",input_json:JSON.stringify({timelineId:"timeline-1"})};
 const progress=[];
 const result=await executeMediaJob({db,job,mediaRoot,activeProcesses:new Map(),onProgress:value=>progress.push(value)});
 assert.equal(result.outputAsset.mediaType,"video/mp4");
 assert.equal(result.render.videoClips,1);
 assert.equal(result.render.width,1280);
 assert.ok(result.outputAsset.size>0);
 assert.ok(progress.some(x=>x>=90));
 const args=await readFile(capture,"utf8");
 assert.match(args,/concat=n=1/);
 assert.match(args,/libx264/);
 const stored=db.prepare("SELECT * FROM assets WHERE id=?").get(result.outputAsset.id);
 assert.ok(await stat(join(mediaRoot,stored.storage_path)));
 assert.equal(stored.derivative_of,null);
 assert.equal(JSON.parse(stored.metadata_json).timelineId,"timeline-1");
 console.log("Timeline render worker checks passed: authorized source resolution, FFmpeg filter graph, progress, MP4 output and derivative asset persistence.");
}finally{
 db.close();
 if(oldPath===undefined)delete process.env.FFMPEG_PATH;else process.env.FFMPEG_PATH=oldPath;
 if(oldCapture===undefined)delete process.env.FFMPEG_CAPTURE;else process.env.FFMPEG_CAPTURE=oldCapture;
 await rm(root,{recursive:true,force:true});
}
