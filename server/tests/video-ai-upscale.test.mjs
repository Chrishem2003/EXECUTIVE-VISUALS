import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVideoAiUpscaleProcessor } from "../video-ai-upscale.mjs";

async function fixture(t,{outputFrames=3,outputWidth=128,outputHeight=128,outputAudio=1,sourceSubtitles=0,outputSubtitles=0,timestamps="0.000000\n0.500000\n1.000000\n",sourceTransfer="bt709",mutateSourceOnAssembly=false}={}){
 const root=await mkdtemp(join(tmpdir(),"ev-video-upscale-test-"));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const sourcePath=join(root,"source.mp4"),outputPath=join(root,"result.mp4");
 await writeFile(sourcePath,"test-video-source");
 const sourceStreams=[
  {codec_type:"video",codec_name:"h264",width:64,height:64,avg_frame_rate:"2/1",r_frame_rate:"2/1",nb_read_frames:"3",duration:"1.5",start_time:"0",pix_fmt:"yuv420p",bits_per_raw_sample:"8",color_range:"tv",color_space:"bt709",color_transfer:sourceTransfer,color_primaries:"bt709"},
  ...Array.from({length:1},()=>({codec_type:"audio",codec_name:"aac",start_time:"0",sample_rate:"48000",channels:2})),
  ...Array.from({length:sourceSubtitles},()=>({codec_type:"subtitle",codec_name:"subrip"}))
 ];
 const outputStreams=[
  {codec_type:"video",codec_name:"h264",width:outputWidth,height:outputHeight,avg_frame_rate:"2/1",r_frame_rate:"2/1",nb_read_frames:String(outputFrames),duration:"1.5",start_time:"0",pix_fmt:"yuv420p"},
  ...Array.from({length:outputAudio},()=>({codec_type:"audio",codec_name:"aac",start_time:"0",sample_rate:"48000",channels:2})),
  ...Array.from({length:outputSubtitles},()=>({codec_type:"subtitle",codec_name:"mov_text"}))
 ];
 const temporalMetadata=[40,70,41,72,42].map((saturation,index)=>"[Parsed_metadata] frame:"+index+" pts:"+(index*14062)+" pts_time:"+(index*0.125).toFixed(6)+"\n[Parsed_metadata] lavfi.signalstats.YAVG=80\n[Parsed_metadata] lavfi.signalstats.SATAVG="+saturation+"\n[Parsed_metadata] lavfi.signalstats.UAVG=128\n[Parsed_metadata] lavfi.signalstats.VAVG=128").join("\n");
 let capturedAssemblyArgs=[];
 const runCommand=async(binary,args)=>{
  if(binary==="ffprobe"&&args.includes("-count_frames")){
   const isOutput=args.at(-1)===outputPath;
   return {stdout:JSON.stringify({streams:isOutput?outputStreams:sourceStreams,format:{duration:"1.5"}}),stderr:""};
  }
  if(binary==="ffprobe"&&args.includes("-show_frames"))return {stdout:timestamps,stderr:""};
  if(binary==="ffmpeg"&&args.includes("-vsync")){
   const pattern=args.at(-1),dir=pattern.slice(0,pattern.lastIndexOf("/"));
   await mkdir(dir,{recursive:true});
   for(let i=0;i<3;i++)await writeFile(join(dir,String(i).padStart(8,"0")+".png"),"frame");
   return {stdout:"",stderr:""};
  }
  if(binary==="ffmpeg"&&args.some(value=>String(value).includes("gt(scene")) )return {stdout:"",stderr:""};
  if(binary==="ffmpeg"&&args.some(value=>String(value).includes("signalstats")))return {stdout:"",stderr:temporalMetadata};
  if(binary==="ffmpeg"){
   capturedAssemblyArgs=args;
   await writeFile(args.at(-1),"rendered-video");
   if(mutateSourceOnAssembly)await writeFile(sourcePath,"mutated-source-bytes");
   return {stdout:"",stderr:""};
  }
  throw new Error("Unexpected command "+binary);
 };
 const observedOptions=[];
 const upscalerFactory=()=>({execute:async(options)=>{observedOptions.push({threads:options.threads,tta:options.tta,gpu:options.gpu});await writeFile(options.outputPath,"upscaled-frame");return {outputDimensions:{width:128,height:128},tileAttempts:[256],tileFallbackUsed:observedOptions.length===2};}});
 const processor=createVideoAiUpscaleProcessor({runCommand,upscalerFactory,maxFrames:10,maxDurationSeconds:5,tempRoot:root});
 return {root,sourcePath,outputPath,processor,observedOptions,get capturedAssemblyArgs(){return capturedAssemblyArgs;}};
}

test("video AI upscaler enhances every frame, retains audio streams and verifies exact output frame count",async t=>{
 const f=await fixture(t);
 const result=await f.processor.process({sourcePath:f.sourcePath,outputPath:f.outputPath,scale:2});
 assert.equal(result.frameCount,3);
 assert.deepEqual(result.inputDimensions,{width:64,height:64});
 assert.deepEqual(result.outputDimensions,{width:128,height:128});
 assert.equal(result.audioStreams,1);
 assert.equal(result.audioHandling,"original-audio-streams-copied");
 assert.equal(result.temporalConsistency,"not-certified");
 assert.equal(result.temporalQuality.status,"completed");
 assert.equal(result.temporalQuality.sampleCount,5);
 assert.ok(result.temporalQuality.findings.some(item=>item.code==="ALTERNATING_SATURATION_INSTABILITY"));
 assert.equal(result.qualityReviewRequired,true);
 assert.equal((await readFile(f.outputPath)).toString(),"rendered-video");
});

test("video AI upscaler rejects variable-frame-rate input before enhancement",async t=>{
 const f=await fixture(t,{timestamps:"0.000000\n0.500000\n1.250000\n"});
 await assert.rejects(f.processor.process({sourcePath:f.sourcePath,outputPath:f.outputPath,scale:2}),error=>error.code==="VIDEO_AI_UPSCALE_VFR_UNSUPPORTED");
});

test("video AI upscaler rejects HDR before frame extraction",async t=>{
 const f=await fixture(t,{sourceTransfer:"smpte2084"});
 await assert.rejects(f.processor.process({sourcePath:f.sourcePath,outputPath:f.outputPath,scale:2}),error=>error.code==="VIDEO_AI_UPSCALE_HDR_UNSUPPORTED");
});

test("video AI upscaler deletes a rendered file when frame-count verification fails",async t=>{
 const f=await fixture(t,{outputFrames:2});
 await assert.rejects(f.processor.process({sourcePath:f.sourcePath,outputPath:f.outputPath,scale:2}),error=>error.code==="VIDEO_AI_UPSCALE_FRAME_COUNT_MISMATCH");
 await assert.rejects(readFile(f.outputPath));
});

test("video AI upscaler stops immediately when its job is cancelled",async t=>{
 const f=await fixture(t);
 const controller=new AbortController();controller.abort();
 await assert.rejects(f.processor.process({sourcePath:f.sourcePath,outputPath:f.outputPath,scale:2,signal:controller.signal}),error=>error.code==="JOB_CANCELLED");
});

test("video AI upscaler rejects audio stream loss and removes the output",async t=>{
 const f=await fixture(t,{outputAudio:0});
 await assert.rejects(f.processor.process({sourcePath:f.sourcePath,outputPath:f.outputPath,scale:2}),error=>error.code==="VIDEO_AI_UPSCALE_AUDIO_STREAM_MISMATCH");
 await assert.rejects(readFile(f.outputPath));
});

test("video AI upscaler rejects source replacement during processing and removes the output",async t=>{
 const f=await fixture(t,{mutateSourceOnAssembly:true});
 await assert.rejects(f.processor.process({sourcePath:f.sourcePath,outputPath:f.outputPath,scale:2}),error=>error.code==="VIDEO_AI_UPSCALE_SOURCE_CHANGED");
 await assert.rejects(readFile(f.outputPath));
});

test("video AI upscaler passes explicit NCNN tuning and records per-frame automatic tile fallback",async t=>{
 const f=await fixture(t);
 const result=await f.processor.process({sourcePath:f.sourcePath,outputPath:f.outputPath,scale:2,threads:"2:3:2",tta:true,gpu:"auto"});
 assert.deepEqual(f.observedOptions[0],{threads:"2:3:2",tta:true,gpu:"auto"});
 assert.equal(result.tileFallbackCount,1);
 assert.deepEqual(result.tileFallbackFrames,[1]);
});

test("video AI upscaler preserves text subtitle streams as mov_text",async t=>{
 const f=await fixture(t,{sourceSubtitles:1,outputSubtitles:1});
 const result=await f.processor.process({sourcePath:f.sourcePath,outputPath:f.outputPath,scale:2});
 assert.equal(result.subtitleStreams,1);
 assert.equal(result.subtitleHandling,"subtitles-transcoded-to-mov_text");
 assert.ok(f.capturedAssemblyArgs.includes("1:s?"));
 assert.ok(f.capturedAssemblyArgs.includes("mov_text"));
});

test("video AI upscaler rejects unsafe temporary-storage and output-pixel budgets",()=>{
 const adapters={runCommand:async()=>({stdout:"",stderr:""}),upscalerFactory:()=>({execute:async()=>({})})};
 assert.throws(()=>createVideoAiUpscaleProcessor({...adapters,maxTempBytes:1024}),/temporary storage budget/);
 assert.throws(()=>createVideoAiUpscaleProcessor({...adapters,maxOutputPixels:100000001}),/output pixel budget/);
});
