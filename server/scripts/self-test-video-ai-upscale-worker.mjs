import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createVideoAiUpscaleProcessor } from "../video-ai-upscale.mjs";
import { createRealEsrganAdapter } from "../ai-upscale-engine.mjs";

const fail=(message,code="VIDEO_AI_UPSCALE_SELF_TEST_FAILED")=>Object.assign(new Error(message),{code});
const captureLimit=8_000_000;

function runCommand(binary,args,{timeoutMs=10*60*1000,signal,maxCaptureBytes=16000}={}){
  const executable=binary==="ffmpeg"?(process.env.FFMPEG_PATH||"ffmpeg"):binary==="ffprobe"?(process.env.FFPROBE_PATH||"ffprobe"):binary;
  const limit=Number.isSafeInteger(maxCaptureBytes)&&maxCaptureBytes>=1024?Math.min(maxCaptureBytes,captureLimit):16000;
  return new Promise((resolvePromise,reject)=>{
    if(signal?.aborted)return reject(fail("Video worker self-test was cancelled.","JOB_CANCELLED"));
    const child=spawn(executable,args,{shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="",settled=false,timer=null;
    const finish=(error,result)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener("abort",abort);
      if(error)reject(error);else resolvePromise(result);
    };
    const abort=()=>{child.kill("SIGTERM");const killTimer=setTimeout(()=>child.kill("SIGKILL"),2000);killTimer.unref?.();finish(fail("Video worker self-test was cancelled.","JOB_CANCELLED"));};
    timer=setTimeout(()=>{child.kill("SIGKILL");finish(fail("Video worker self-test command timed out.","VIDEO_AI_UPSCALE_SELF_TEST_TIMEOUT"));},timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort",abort,{once:true});
    child.stdout.on("data",chunk=>{stdout=(stdout+chunk.toString()).slice(-limit);});
    child.stderr.on("data",chunk=>{stderr=(stderr+chunk.toString()).slice(-limit);});
    child.once("error",error=>finish(fail("Could not start "+executable+": "+error.message,"VIDEO_AI_UPSCALE_ENGINE_UNAVAILABLE")));
    child.once("close",code=>code===0?finish(null,{stdout,stderr}):finish(fail((stderr||executable+" exited with code "+code).slice(-3000),"VIDEO_AI_UPSCALE_PROCESS_FAILED")));
  });
}

async function main(){
  if(process.env.AI_UPSCALE_ENABLED!=="true")throw fail("Set AI_UPSCALE_ENABLED=true on the worker after installing the NCNN/Vulkan executable and model weights.","AI_UPSCALE_DISABLED");
  if(process.env.AI_VIDEO_UPSCALE_ENABLED!=="true")throw fail("Set AI_VIDEO_UPSCALE_ENABLED=true on the worker to run this isolated smoke test.","VIDEO_AI_UPSCALE_DISABLED");
  const workspace=await mkdtemp(join(tmpdir(),"ev-video-ai-worker-self-test-"));
  const sourcePath=join(workspace,"self-test-source.mp4");
  const outputPath=join(workspace,"self-test-output.mp4");
  try{
    await runCommand("ffmpeg",[
      "-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc2=size=128x128:rate=2",
      "-frames:v","4","-an","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p",sourcePath
    ],{timeoutMs:60000});
    const processor=createVideoAiUpscaleProcessor({
      runCommand,
      upscalerFactory:options=>createRealEsrganAdapter(options),
      maxFrames:4,
      maxDurationSeconds:10,
      maxInputBytes:32*1024*1024,
      maxOutputBytes:128*1024*1024,
      maxTempBytes:512*1024*1024,
      maxOutputPixels:1_000_000,
      frameTimeoutMs:10*60*1000,
      jobTimeoutMs:15*60*1000,
      tempRoot:workspace
    });
    const result=await processor.process({sourcePath,outputPath,model:"realesrgan-x4plus",scale:2,tile:0});
    const info=await stat(outputPath);
    if(!info.isFile()||info.size<1)throw fail("The worker smoke test did not produce a non-empty MP4.");
    if(result.frameCount!==4||result.outputDimensions?.width!==256||result.outputDimensions?.height!==256)throw fail("Worker smoke test output did not match the expected 4-frame 256×256 profile.");
    const summary={
      passed:true,
      workerSelfTestPassed:true,
      model:result.model,
      frameCount:result.frameCount,
      inputDimensions:result.inputDimensions,
      outputDimensions:result.outputDimensions,
      outputBytes:info.size,
      audioStreams:result.audioStreams,
      subtitleStreams:result.subtitleStreams,
      temporalConsistency:result.temporalConsistency,
      qualityReviewRequired:result.qualityReviewRequired,
      note:"Execution only; this does not approve visual quality or temporal consistency."
    };
    process.stdout.write(JSON.stringify(summary,null,2)+"\n");
    process.stdout.write("After reviewing this output on the exact worker host, set AI_VIDEO_UPSCALE_WORKER_SELF_TEST_PASSED=true on both the worker and API service.\n");
  }finally{
    await rm(workspace,{recursive:true,force:true});
  }
}
main().catch(error=>{process.stderr.write(JSON.stringify({passed:false,code:error.code||"VIDEO_AI_UPSCALE_SELF_TEST_FAILED",error:error.message},null,2)+"\n");process.exitCode=1;});
