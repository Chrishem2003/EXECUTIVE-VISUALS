import { lstat, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const fail=(message,code="VIDEO_AI_UPSCALE_INVALID")=>Object.assign(new Error(message),{code});
const rational=value=>{
  const [a,b]=String(value||"").split("/").map(Number);
  return Number.isFinite(a)&&Number.isFinite(b)&&b>0?a/b:null;
};
const finite=value=>Number.isFinite(Number(value))?Number(value):null;
const checkCancelled=signal=>{if(signal?.aborted)throw fail("Video AI upscaling was cancelled.","JOB_CANCELLED");};
const run=async(runCommand,binary,args,options={})=>{
  checkCancelled(options.signal);
  return runCommand(binary,args,options);
};
function parseProbe(stdout){
  let value;
  try{value=JSON.parse(stdout||"{}");}catch{throw fail("Video metadata could not be parsed.","VIDEO_AI_UPSCALE_PROBE_INVALID");}
  const streams=Array.isArray(value.streams)?value.streams:[];
  const video=streams.find(item=>item.codec_type==="video");
  if(!video)throw fail("The source has no readable video stream.","VIDEO_STREAM_MISSING");
  const audio=streams.filter(item=>item.codec_type==="audio");
  const frames=Number(video.nb_read_frames);
  const fps=rational(video.avg_frame_rate)||rational(video.r_frame_rate);
  const width=Number(video.width),height=Number(video.height);
  if(!Number.isSafeInteger(frames)||frames<1||!Number.isFinite(fps)||fps<=0||!Number.isInteger(width)||!Number.isInteger(height)||width<64||height<64){
    throw fail("Video frame count, dimensions or frame rate are unavailable.","VIDEO_AI_UPSCALE_PROBE_INVALID");
  }
  return {raw:value,video,audio,frames,fps,width,height,duration:finite(video.duration)||finite(value.format?.duration),startTime:finite(video.start_time)||0};
}
function parseFrameTimes(stdout){
  const times=String(stdout||"").split(/\r?\n/).map(line=>finite(line.trim())).filter(value=>value!==null);
  return times;
}
function assertConstantFrameRate(times,fps,frameCount){
  if(times.length!==frameCount)throw fail("Frame timestamp count does not match the decoded frame count; variable or incomplete timestamps are not supported.","VIDEO_AI_UPSCALE_TIMESTAMPS_INVALID");
  const expected=1/fps,tolerance=Math.max(0.0005,expected*0.005);
  for(let i=1;i<times.length;i++){
    const delta=times[i]-times[i-1];
    if(delta<=0||Math.abs(delta-expected)>tolerance)throw fail("Variable-frame-rate video is not supported yet. Convert the source to constant frame rate before enhancement.","VIDEO_AI_UPSCALE_VFR_UNSUPPORTED");
  }
}
function pixelFormatFor(source){
  const format=String(source.pix_fmt||"");
  const map={"yuv420p":"yuv420p","yuvj420p":"yuv420p","yuv422p":"yuv422p","yuvj422p":"yuv422p","yuv444p":"yuv444p","yuvj444p":"yuv444p"};
  if(!map[format])throw fail("Only 8-bit SDR 4:2:0, 4:2:2 or 4:4:4 sources are supported; HDR and high-bit-depth sources are rejected to prevent silent quality loss.","VIDEO_AI_UPSCALE_PIXEL_FORMAT_UNSUPPORTED");
  const transfer=String(source.color_transfer||"").toLowerCase();
  if(["smpte2084","arib-std-b67"].includes(transfer))throw fail("HDR video is not supported by this 8-bit frame enhancement path.","VIDEO_AI_UPSCALE_HDR_UNSUPPORTED");
  return map[format];
}
function colorArgs(source){
  const args=[];
  for(const [field,flag,allowed] of [
    ["color_primaries","-color_primaries",new Set(["bt709","bt470bg","smpte170m","bt2020"])],
    ["color_transfer","-color_trc",new Set(["bt709","bt470bg","smpte170m","iec61966-2-1","gamma22","gamma28"])],
    ["color_space","-colorspace",new Set(["bt709","fcc","bt470bg","smpte170m","bt2020nc","bt2020c"])],
    ["color_range","-color_range",new Set(["tv","pc"])]
  ]){
    const value=String(source[field]||"").toLowerCase();
    if(allowed.has(value))args.push(flag,value);
  }
  return args;
}
export function createVideoAiUpscaleProcessor({
  runCommand,
  upscalerFactory,
  maxFrames=1800,
  maxDurationSeconds=600,
  maxInputBytes=2*1024*1024*1024,
  maxOutputBytes=4*1024*1024*1024,
  maxOutputPixels=40_000_000,
  frameTimeoutMs=30*60*1000,
  jobTimeoutMs=2*60*60*1000,
  tempRoot=tmpdir()
}={}){
  if(typeof runCommand!=="function"||typeof upscalerFactory!=="function")throw new TypeError("Video AI upscaling requires process and image-upscaler adapters.");
  if(!Number.isInteger(maxFrames)||maxFrames<1||maxFrames>18000)throw new TypeError("Video frame limit must be between 1 and 18,000.");
  if(!Number.isFinite(maxDurationSeconds)||maxDurationSeconds<=0||maxDurationSeconds>3600)throw new TypeError("Video duration limit is invalid.");
  async function process({
    sourcePath,outputPath,model="realesrgan-x4plus",scale=2,tile=0,signal,onProgress=()=>{}
  }={}){
    const started=Date.now();
    const progress=value=>{checkCancelled(signal);if(Date.now()-started>jobTimeoutMs)throw fail("Video AI upscaling exceeded its total job time budget.","VIDEO_AI_UPSCALE_TIMEOUT");onProgress(Math.max(0,Math.min(99,Math.round(value))));};
    if(!sourcePath||!outputPath||resolve(sourcePath)===resolve(outputPath))throw fail("Distinct source and output paths are required.","VIDEO_AI_UPSCALE_INVALID_PATH");
    if(![2,4].includes(Number(scale)))throw fail("Video AI upscale supports 2x or 4x image-model scale.","AI_UPSCALE_INVALID_OPTIONS");
    const sourceInfo=await lstat(sourcePath).catch(()=>null);
    if(!sourceInfo?.isFile()||sourceInfo.isSymbolicLink()||sourceInfo.size<1||sourceInfo.size>maxInputBytes)throw fail("Video source must be a readable regular file within the input byte budget.","VIDEO_AI_UPSCALE_INPUT_INVALID");
    const existing=await lstat(outputPath).catch(()=>null);
    if(existing)throw fail("Video output already exists; source files are never overwritten.","VIDEO_AI_UPSCALE_OUTPUT_EXISTS");
    let workspace=null,outputCreated=false;
    try{
      progress(3);
      const probeResult=await run(runCommand,"ffprobe",["-v","error","-count_frames","-show_entries","stream=codec_type,width,height,avg_frame_rate,r_frame_rate,nb_read_frames,duration,start_time,pix_fmt,bits_per_raw_sample,color_range,color_space,color_transfer,color_primaries","-show_entries","format=duration","-of","json",sourcePath],{timeoutMs:10*60*1000,signal,maxCaptureBytes:2_000_000});
      const source=parseProbe(probeResult.stdout);
      if(source.frames>maxFrames)throw fail("Video exceeds the configured frame budget.","VIDEO_AI_UPSCALE_FRAME_LIMIT");
      if(source.duration!==null&&source.duration>maxDurationSeconds)throw fail("Video exceeds the configured duration budget.","VIDEO_AI_UPSCALE_DURATION_LIMIT");
      const inputBytes=sourceInfo.size;
      const outputWidth=source.width*Number(scale),outputHeight=source.height*Number(scale);
      if(outputWidth>7680||outputHeight>4320||outputWidth*outputHeight>maxOutputPixels)throw fail("Requested video output dimensions exceed the worker pixel budget.","AI_UPSCALE_OUTPUT_BUDGET_EXCEEDED");
      const outputPixelFormat=pixelFormatFor(source.video);
      const videoStart=finite(source.video.start_time)||0;
      for(const audio of source.audio){
        const audioStart=finite(audio.start_time)||0;
        if(Math.abs(audioStart-videoStart)>1/source.fps)throw fail("Audio and video start timestamps differ by more than one frame; source synchronization cannot be safely preserved.","VIDEO_AI_UPSCALE_AUDIO_SYNC_UNSUPPORTED");
      }
      progress(7);
      const timestampResult=await run(runCommand,"ffprobe",["-v","error","-select_streams","v:0","-show_frames","-show_entries","frame=best_effort_timestamp_time","-of","csv=p=0",sourcePath],{timeoutMs:10*60*1000,signal,maxCaptureBytes:Math.min(8_000_000,Math.max(64_000,source.frames*24))});
      const frameTimes=parseFrameTimes(timestampResult.stdout);
      assertConstantFrameRate(frameTimes,source.fps,source.frames);
      workspace=await mkdtemp(join(tempRoot,"executive-video-ai-upscale-"));
      const inputFrames=join(workspace,"input"),outputFrames=join(workspace,"enhanced");
      await mkdir(inputFrames);await mkdir(outputFrames);
      const inputPattern=join(inputFrames,"%08d.png");
      await run(runCommand,"ffmpeg",["-hide_banner","-nostdin","-y","-i",sourcePath,"-map","0:v:0","-an","-sn","-dn","-vsync","0","-start_number","0",inputPattern],{timeoutMs:20*60*1000,signal,maxCaptureBytes:256_000});
      const extracted=(await readdir(inputFrames)).filter(name=>/^\d{8}\.png$/.test(name)).sort();
      if(extracted.length!==source.frames)throw fail("Extracted frame count does not match the source video; no derivative was published.","VIDEO_AI_UPSCALE_FRAME_COUNT_MISMATCH");
      progress(12);
      const upscaler=upscalerFactory({timeoutMs:frameTimeoutMs,maxOutputBytes:250*1024*1024,maxOutputPixels});
      if(!upscaler||typeof upscaler.execute!=="function")throw fail("The configured AI image upscaler is unavailable.","AI_UPSCALE_ENGINE_UNAVAILABLE");
      const tileAttempts=[];
      for(let index=0;index<extracted.length;index++){
        checkCancelled(signal);
        if(Date.now()-started>jobTimeoutMs)throw fail("Video AI upscaling exceeded its total job time budget.","VIDEO_AI_UPSCALE_TIMEOUT");
        const inputFrame=join(inputFrames,extracted[index]);
        const outputFrame=join(outputFrames,extracted[index]);
        const result=await upscaler.execute({inputPath:inputFrame,outputPath:outputFrame,model,scale:Number(scale),tile:Number(tile),format:"png",signal});
        if(result.outputDimensions?.width!==outputWidth||result.outputDimensions?.height!==outputHeight)throw fail("An enhanced frame has unexpected dimensions; the video derivative was rejected.","VIDEO_AI_UPSCALE_FRAME_DIMENSIONS_MISMATCH");
        tileAttempts.push(...(result.tileAttempts||[]));
        progress(12+Math.round(((index+1)/source.frames)*70));
      }
      const enhanced=(await readdir(outputFrames)).filter(name=>/^\d{8}\.png$/.test(name)).sort();
      if(enhanced.length!==source.frames)throw fail("Enhanced frame count does not match the source video.","VIDEO_AI_UPSCALE_FRAME_COUNT_MISMATCH");
      progress(84);
      const fpsText=source.video.avg_frame_rate||source.video.r_frame_rate;
      const audioCodecSafe=source.audio.every(stream=>["aac","mp3","ac3","eac3","alac"].includes(String(stream.codec_name||"").toLowerCase()));
      const args=["-hide_banner","-nostdin","-y","-framerate",fpsText,"-start_number","0","-i",join(outputFrames,"%08d.png"),"-i",sourcePath,"-map","0:v:0","-map","1:a?","-map_metadata","1","-map_chapters","1","-frames:v",String(source.frames),"-c:v","libx264","-preset","medium","-crf","18","-pix_fmt",outputPixelFormat,...colorArgs(source.video),"-fps_mode","cfr","-c:a",audioCodecSafe?"copy":"aac"];
      if(!audioCodecSafe&&source.audio.length)args.push("-b:a","192k");
      args.push("-movflags","+faststart",outputPath);
      outputCreated=true;
      await run(runCommand,"ffmpeg",args,{timeoutMs:30*60*1000,signal,maxCaptureBytes:256_000});
      progress(94);
      const outputProbeResult=await run(runCommand,"ffprobe",["-v","error","-count_frames","-show_entries","stream=codec_type,width,height,avg_frame_rate,nb_read_frames,codec_name","-show_entries","format=duration","-of","json",outputPath],{timeoutMs:10*60*1000,signal,maxCaptureBytes:2_000_000});
      const output=parseProbe(outputProbeResult.stdout);
      if(output.frames!==source.frames)throw fail("Rendered video frame count changed during enhancement.","VIDEO_AI_UPSCALE_FRAME_COUNT_MISMATCH");
      if(output.width!==outputWidth||output.height!==outputHeight)throw fail("Rendered video dimensions do not match the requested upscale factor.","VIDEO_AI_UPSCALE_DIMENSIONS_MISMATCH");
      if(output.audio.length!==source.audio.length)throw fail("Rendered video did not preserve the source audio stream count.","VIDEO_AI_UPSCALE_AUDIO_STREAM_MISMATCH");
      const outputInfo=await stat(outputPath);
      if(!outputInfo.isFile()||outputInfo.size<1||outputInfo.size>maxOutputBytes)throw fail("Rendered video is empty or exceeds the output byte budget.","VIDEO_AI_UPSCALE_OUTPUT_INVALID");
      progress(98);
      return {
        path:outputPath,byteSize:outputInfo.size,inputBytes,frameCount:source.frames,
        frameRate:{numerator:Number(String(fpsText).split("/")[0]),denominator:Number(String(fpsText).split("/")[1]||1)},
        inputDimensions:{width:source.width,height:source.height},outputDimensions:{width:outputWidth,height:outputHeight},
        model,scale:Number(scale),tile:Number(tile),audioStreams:source.audio.length,
        audioHandling:audioCodecSafe?"original-audio-streams-copied":"audio-transcoded-to-aac",
        frameProcessing:"sequential-image-model-inference",temporalConsistency:"not-certified",
        qualityReviewRequired:true,qualityReviewReasons:["temporal-consistency-not-certified","human-review-required"]
      };
    }catch(error){
      if(outputCreated)await (await import("node:fs/promises")).unlink(outputPath).catch(()=>{});
      throw error;
    }finally{
      if(workspace)await rm(workspace,{recursive:true,force:true}).catch(()=>{});
    }
  }
  return Object.freeze({process});
}
