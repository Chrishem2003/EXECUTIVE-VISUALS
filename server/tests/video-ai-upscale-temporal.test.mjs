import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, truncate } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVideoAiUpscaleProcessor } from "../video-ai-upscale.mjs";

async function fixture(t,{temporalFrames=3,temporalWidth=256,temporalHeight=256,temporalBytes=32}={}){
 const root=await mkdtemp(join(tmpdir(),"ev-flashvsr-video-test-"));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const sourcePath=join(root,"source.mp4"),outputPath=join(root,"result.mp4");
 await writeFile(sourcePath,"test-video-source");
 const sourceStreams=[
  {codec_type:"video",codec_name:"h264",width:64,height:64,avg_frame_rate:"2/1",r_frame_rate:"2/1",nb_read_frames:"3",duration:"1.5",start_time:"0",pix_fmt:"yuv420p",color_range:"tv",color_space:"bt709",color_transfer:"bt709",color_primaries:"bt709"},
  {codec_type:"audio",codec_name:"aac",start_time:"0",sample_rate:"48000",channels:2}
 ];
 const temporalStreams=[
  {codec_type:"video",codec_name:"h264",width:temporalWidth,height:temporalHeight,avg_frame_rate:"2/1",r_frame_rate:"2/1",nb_read_frames:String(temporalFrames),duration:"1.5",start_time:"0",pix_fmt:"yuv420p"}
 ];
 const outputStreams=[...temporalStreams,{codec_type:"audio",codec_name:"aac",start_time:"0",sample_rate:"48000",channels:2}];
 const metadata=[40,70,41,72,42].map((saturation,index)=>"[Parsed_metadata] frame:"+index+" pts:"+(index*14062)+" pts_time:"+(index*0.125).toFixed(6)+"\n[Parsed_metadata] lavfi.signalstats.YAVG=80\n[Parsed_metadata] lavfi.signalstats.SATAVG="+saturation+"\n[Parsed_metadata] lavfi.signalstats.UAVG=128\n[Parsed_metadata] lavfi.signalstats.VAVG=128").join("\n");
 let assemblyArgs=[];
 const runCommand=async(binary,args)=>{
  const target=String(args.at(-1)||"");
  if(binary==="ffprobe"&&args.includes("-count_frames")){
   const isTemporal=target.includes("flashvsr-temporal-output.mp4");
   const isOutput=target===outputPath;
   return {stdout:JSON.stringify({streams:isOutput?outputStreams:isTemporal?temporalStreams:sourceStreams,format:{duration:"1.5"}}),stderr:""};
  }
  if(binary==="ffprobe"&&args.includes("-show_frames"))return {stdout:"0.000000\n0.500000\n1.000000\n",stderr:""};
  if(binary==="ffmpeg"&&args.some(value=>String(value).includes("gt(scene")))return {stdout:"",stderr:""};
  if(binary==="ffmpeg"&&args.some(value=>String(value).includes("signalstats")))return {stdout:"",stderr:metadata};
  if(binary==="ffmpeg"){
   assemblyArgs=args;
   await writeFile(target,"rendered-temporal-video");
   return {stdout:"",stderr:""};
  }
  throw new Error("Unexpected command "+binary);
 };
 const temporalUpscalerFactory=()=>({execute:async({outputPath:path})=>{
  await writeFile(path,"temporal-output");
  if(temporalBytes>32)await truncate(path,temporalBytes);
  return {ok:true,model:"FlashVSR-v1.1-tiny-long",temporalModel:true,license:"Apache-2.0"};
 }});
 const processor=createVideoAiUpscaleProcessor({
  runCommand,upscalerFactory:()=>{throw new Error("Framewise engine must not run");},
  temporalUpscalerFactory,maxFrames:10,maxDurationSeconds:5,maxTempBytes:64*1024*1024,tempRoot:root
 });
 return {sourcePath,outputPath,processor,get assemblyArgs(){return assemblyArgs;}};
}

test("FlashVSR temporal path verifies exact frames, 4x dimensions, timestamps and source audio remux",async t=>{
 const f=await fixture(t);
 const result=await f.processor.process({sourcePath:f.sourcePath,outputPath:f.outputPath,engine:"flashvsr-v1.1-tiny-long",model:"FlashVSR-v1.1-tiny-long",scale:4});
 assert.equal(result.engine,"flashvsr-v1.1-tiny-long");
 assert.equal(result.temporalModel,true);
 assert.equal(result.temporalModelLicense,"Apache-2.0");
 assert.equal(result.frameProcessing,"temporal-video-model-inference");
 assert.equal(result.frameCount,3);
 assert.deepEqual(result.outputDimensions,{width:256,height:256});
 assert.equal(result.audioStreams,1);
 assert.equal(result.temporalConsistency,"not-certified");
 assert.equal(result.qualityReviewRequired,true);
 assert.ok(f.assemblyArgs.some(value=>String(value).includes("flashvsr-temporal-output.mp4")));
 assert.ok(f.assemblyArgs.includes("1:a?"));
 assert.equal((await readFile(f.outputPath)).toString(),"rendered-temporal-video");
});

test("FlashVSR temporal path rejects non-4x scale before invoking the worker",async t=>{
 const f=await fixture(t);
 await assert.rejects(f.processor.process({sourcePath:f.sourcePath,outputPath:f.outputPath,engine:"flashvsr-v1.1-tiny-long",scale:2}),error=>error.code==="FLASHVSR_SCALE_UNSUPPORTED");
});

test("FlashVSR temporal path rejects a mismatched frame count and removes the derivative",async t=>{
 const f=await fixture(t,{temporalFrames:2});
 await assert.rejects(f.processor.process({sourcePath:f.sourcePath,outputPath:f.outputPath,engine:"flashvsr-v1.1-tiny-long",scale:4}),error=>error.code==="FLASHVSR_OUTPUT_PROFILE_MISMATCH");
 await assert.rejects(readFile(f.outputPath));
});

test("FlashVSR temporal path enforces the intermediate storage budget",async t=>{
 const f=await fixture(t,{temporalBytes:64*1024*1024+1});
 await assert.rejects(f.processor.process({sourcePath:f.sourcePath,outputPath:f.outputPath,engine:"flashvsr-v1.1-tiny-long",scale:4}),error=>error.code==="VIDEO_AI_UPSCALE_TEMP_BUDGET_EXCEEDED");
});
