import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { renderCloudTimeline } from "../server/cloud-ffmpeg-timeline-renderer.mjs";

const ffmpeg=process.env.FFMPEG_PATH||"ffmpeg";
const ffprobe=process.env.FFPROBE_PATH||"ffprobe";
const durationSeconds=Math.max(1,Math.min(30,Number(process.env.BENCHMARK_DURATION_SECONDS)||4));
const iterations=Math.max(1,Math.min(5,Number(process.env.BENCHMARK_ITERATIONS)||1));
const trackCounts=[1,4,16];
const time=value=>({value,rate:1});

function run(bin,args,encoding="utf8"){
 return execFileSync(bin,args,{encoding,stdio:["ignore","pipe","pipe"],maxBuffer:8*1024*1024});
}

async function main(){
 const root=await mkdtemp(join(tmpdir(),"executive-visuals-audio-benchmark-"));
 try{
  const video=join(root,"benchmark-video.mp4"),audio=join(root,"benchmark-mono.wav");
  run(ffmpeg,["-hide_banner","-loglevel","error","-y","-f","lavfi","-i",`color=c=black:s=320x240:r=24:d=${durationSeconds}`,"-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p",video]);
  run(ffmpeg,["-hide_banner","-loglevel","error","-y","-f","lavfi","-i",`sine=frequency=440:duration=${durationSeconds}`,"-ac","1","-c:a","pcm_s16le",audio]);
  const assets=new Map([
   ["benchmark-video",{path:video,asset:{id:"benchmark-video",mediaType:"video/mp4",originalName:"benchmark-video.mp4"}}],
   ["benchmark-audio",{path:audio,asset:{id:"benchmark-audio",mediaType:"audio/wav",originalName:"benchmark-mono.wav"}}]
  ]);
  const results=[];
  for(const trackCount of trackCounts){
   for(let iteration=1;iteration<=iterations;iteration++){
    const workDir=join(root,`tracks-${trackCount}-iteration-${iteration}`);
    await mkdir(workDir,{recursive:true});
    const tracks=[
     {id:"video",kind:"video",clips:[{id:"video-clip",assetId:"benchmark-video",timelineStart:time(0),duration:time(durationSeconds),sourceRange:{start:time(0),duration:time(durationSeconds)}}]},
     ...Array.from({length:trackCount},(_,index)=>({
      id:`audio-track-${index+1}`,kind:"audio",
      clips:[{id:`audio-clip-${index+1}`,assetId:"benchmark-audio",timelineStart:time(0),duration:time(durationSeconds),sourceRange:{start:time(0),duration:time(durationSeconds)},gainDb:0,pan:0}]
     }))
    ];
    const timeline={name:`Audio benchmark ${trackCount} tracks`,width:320,height:240,frameRate:{numerator:24,denominator:1},tracks};
    const started=performance.now();
    const output=await renderCloudTimeline({timeline,assets,workDir,onProgress(){}});
    const elapsedMs=performance.now()-started;
    const metadata=JSON.parse(run(ffprobe,["-v","error","-show_entries","format=duration:stream=codec_type,channels,sample_rate","-of","json",output.path]));
    const file=await stat(output.path);
    const renderedDuration=Number(metadata.format?.duration)||durationSeconds;
    results.push({
     trackCount,iteration,elapsedMs:Math.round(elapsedMs*10)/10,
     renderedSeconds:renderedDuration,
     realtimeFactor:Math.round((renderedDuration/(elapsedMs/1000))*100)/100,
     outputBytes:file.size,
     audioStreams:metadata.streams?.filter(stream=>stream.codec_type==="audio").length||0,
     audioChannels:metadata.streams?.find(stream=>stream.codec_type==="audio")?.channels||null
    });
    process.stdout.write(JSON.stringify(results[results.length-1])+"\n");
   }
  }
  const summary=trackCounts.map(trackCount=>{
   const rows=results.filter(row=>row.trackCount===trackCount);
   const mean=rows.reduce((sum,row)=>sum+row.elapsedMs,0)/rows.length;
   return{trackCount,iterations:rows.length,meanElapsedMs:Math.round(mean*10)/10,meanRealtimeFactor:Math.round(rows.reduce((sum,row)=>sum+row.realtimeFactor,0)/rows.length*100)/100};
  });
  process.stdout.write(JSON.stringify({benchmark:"cloud-audio-render",durationSeconds,iterations,summary,results},null,2)+"\n");
 }finally{
  await rm(root,{recursive:true,force:true});
 }
}

main().catch(error=>{process.stderr.write((error?.stack||String(error))+"\n");process.exitCode=1;});
