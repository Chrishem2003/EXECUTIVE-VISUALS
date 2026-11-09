import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { resolve, join } from "node:path";

const parseLastJson = value => {
  const lines=String(value||"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  for(let i=lines.length-1;i>=0;i--){try{return JSON.parse(lines[i]);}catch{}}
  throw Object.assign(new Error("FlashVSR worker did not return a valid JSON result."),{code:"FLASHVSR_INVALID_RESPONSE"});
};

function runProcess(binary,args,{signal,timeoutMs=30*60*1000,maxCaptureBytes=2_000_000,cwd,spawnImpl=spawn}={}){
  return new Promise((resolvePromise,reject)=>{
    if(signal?.aborted)return reject(Object.assign(new Error("FlashVSR inference was cancelled."),{code:"JOB_CANCELLED"}));
    const child=spawnImpl(binary,args,{cwd,windowsHide:true,shell:false,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="",settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener("abort",abort);error?reject(error):resolvePromise(value);};
    const abort=()=>{child.kill("SIGTERM");finish(Object.assign(new Error("FlashVSR inference was cancelled."),{code:"JOB_CANCELLED"}));};
    const timer=setTimeout(()=>{child.kill("SIGTERM");finish(Object.assign(new Error("FlashVSR inference exceeded its execution time budget."),{code:"FLASHVSR_TIMEOUT"}));},timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort",abort,{once:true});
    child.stdout?.on("data",chunk=>{stdout+=chunk.toString();if(stdout.length>maxCaptureBytes){child.kill("SIGTERM");finish(Object.assign(new Error("FlashVSR output exceeded the capture budget."),{code:"FLASHVSR_OUTPUT_LIMIT"}));}});
    child.stderr?.on("data",chunk=>{stderr+=chunk.toString();if(stderr.length>maxCaptureBytes){child.kill("SIGTERM");finish(Object.assign(new Error("FlashVSR diagnostics exceeded the capture budget."),{code:"FLASHVSR_OUTPUT_LIMIT"}));}});
    child.once("error",error=>finish(Object.assign(new Error("FlashVSR Python runtime could not be started: "+error.message),{code:"FLASHVSR_RUNTIME_UNAVAILABLE"})));
    child.once("close",(code,signalName)=>code===0?finish(null,{stdout,stderr}):finish(Object.assign(new Error("FlashVSR process failed ("+(code??signalName)+"): "+stderr.slice(-1200)),{code:"FLASHVSR_INFERENCE_FAILED"})));
  });
}

export function createFlashVsrAdapter({
  pythonExecutable=process.env.FLASHVSR_PYTHON||(process.platform==="win32"?"python":"python3"),
  repoRoot=process.env.FLASHVSR_ROOT||"",
  modelDir=process.env.FLASHVSR_MODEL_DIR||"",
  enabled=process.env.FLASHVSR_ENABLED==="true",
  selfTestPassed=process.env.FLASHVSR_SELF_TEST_PASSED==="true",
  scriptPath=join(process.cwd(),"server","scripts","flashvsr-infer.py"),
  spawnImpl=spawn,
  timeoutMs=2*60*60*1000
}={}){
  const root=repoRoot?resolve(repoRoot):"";
  const weights=modelDir?resolve(modelDir):root?join(root,"examples","WanVSR","FlashVSR-v1.1"):"";
  const script=resolve(scriptPath);
  const run=(args,options={})=>runProcess(pythonExecutable,[script,"--repo-root",root,"--model-dir",weights,...args],{spawnImpl,...options});
  async function probe(){
    if(!root||!weights)return {available:false,executionEnabled:enabled,executionVerified:selfTestPassed,reason:"FLASHVSR_ROOT and model weights are not configured.",model:"FlashVSR-v1.1-tiny-long"};
    const scriptInfo=await lstat(script).catch(()=>null);
    if(!scriptInfo?.isFile()||scriptInfo.isSymbolicLink())return {available:false,executionEnabled:enabled,executionVerified:selfTestPassed,reason:"The isolated FlashVSR bridge script is unavailable.",model:"FlashVSR-v1.1-tiny-long"};
    try{
      const result=await run(["--probe"],{timeoutMs:120_000,maxCaptureBytes:256_000});
      const report=parseLastJson(result.stdout);
      const available=report.available===true;
      return {available,executionEnabled:enabled,executionVerified:selfTestPassed,model:report.model||"FlashVSR-v1.1-tiny-long",license:report.license||"Apache-2.0",runtime:report.runtime||null,checks:report.checks||null,reason:report.reason||(!available?"Python dependencies, CUDA/bfloat16 support or model weights are not ready.":null),ready:available&&enabled&&selfTestPassed};
    }catch(error){return {available:false,executionEnabled:enabled,executionVerified:selfTestPassed,reason:error instanceof Error?error.message:"FlashVSR readiness check failed.",model:"FlashVSR-v1.1-tiny-long"};}
  }
  async function execute({inputPath,outputPath,scale=4,signal,onProgress=()=>{}}={}){
    if(!enabled||!selfTestPassed)throw Object.assign(new Error("FlashVSR requires explicit enablement and a passed local model self-test."),{code:"FLASHVSR_NOT_ENABLED"});
    if(Number(scale)!==4)throw Object.assign(new Error("FlashVSR v1.1 currently supports 4x video super-resolution only."),{code:"FLASHVSR_SCALE_UNSUPPORTED"});
    const result=await run(["--input",resolve(inputPath),"--output",resolve(outputPath),"--scale","4"],{signal,timeoutMs,maxCaptureBytes:2_000_000});
    const report=parseLastJson(result.stdout);
    if(report.ok!==true||report.temporalModel!==true||report.frames<1||report.scale!==4)throw Object.assign(new Error(report.message||"FlashVSR did not produce verified temporal-model output."),{code:"FLASHVSR_OUTPUT_INVALID"});
    const info=await lstat(outputPath).catch(()=>null);
    if(!info?.isFile()||info.isSymbolicLink()||info.size<1)throw Object.assign(new Error("FlashVSR output is not a regular non-empty file."),{code:"FLASHVSR_OUTPUT_INVALID"});
    onProgress(85);
    return report;
  }
  return {probe,execute};
}
