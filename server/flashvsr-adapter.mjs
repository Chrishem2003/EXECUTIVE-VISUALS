import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { resolve, join } from "node:path";

const parseLastJson = value => {
  const lines=String(value||"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  for(let i=lines.length-1;i>=0;i--){try{return JSON.parse(lines[i]);}catch{}}
  throw Object.assign(new Error("FlashVSR worker did not return a valid JSON result."),{code:"FLASHVSR_INVALID_RESPONSE"});
};

function runProcess(binary,args,{signal,timeoutMs=30*60*1000,maxCaptureBytes=2_000_000,killGraceMs=2_000,cwd,spawnImpl=spawn}={}){
  return new Promise((resolvePromise,reject)=>{
    if(signal?.aborted)return reject(Object.assign(new Error("FlashVSR inference was cancelled."),{code:"JOB_CANCELLED"}));
    if(!Number.isSafeInteger(maxCaptureBytes)||maxCaptureBytes<1) return reject(new TypeError("FlashVSR output capture budget must be a positive safe integer."));
    if(!Number.isSafeInteger(killGraceMs)||killGraceMs<0||killGraceMs>30_000) return reject(new TypeError("FlashVSR process termination grace period is invalid."));
    const child=spawnImpl(binary,args,{cwd,windowsHide:true,shell:false,detached:process.platform!=="win32",stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr="",stdoutBytes=0,stderrBytes=0,settled=false,stopError=null,killTimer=null;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(killTimer)clearTimeout(killTimer);signal?.removeEventListener("abort",abort);error?reject(error):resolvePromise(value);};
    const sendSignal=name=>{try{if(process.platform!=="win32"&&child.pid)process.kill(-child.pid,name);else child.kill(name);}catch{try{child.kill(name);}catch{}}};
    const stop=error=>{
      if(settled||stopError)return;
      stopError=error;
      sendSignal("SIGTERM");
      killTimer=setTimeout(()=>{sendSignal("SIGKILL");finish(stopError);},killGraceMs);
    };
    const abort=()=>stop(Object.assign(new Error("FlashVSR inference was cancelled."),{code:"JOB_CANCELLED"}));
    const timer=setTimeout(()=>stop(Object.assign(new Error("FlashVSR inference exceeded its execution time budget."),{code:"FLASHVSR_TIMEOUT"})),timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort",abort,{once:true});
    child.stdout?.on("data",chunk=>{
      if(stopError||settled)return;
      const bytes=Buffer.isBuffer(chunk)?chunk.length:Buffer.byteLength(String(chunk));
      if(stdoutBytes+bytes>maxCaptureBytes){stop(Object.assign(new Error("FlashVSR output exceeded the capture budget."),{code:"FLASHVSR_OUTPUT_LIMIT"}));return;}
      stdoutBytes+=bytes;stdout+=chunk.toString();
    });
    child.stderr?.on("data",chunk=>{
      if(stopError||settled)return;
      const bytes=Buffer.isBuffer(chunk)?chunk.length:Buffer.byteLength(String(chunk));
      if(stderrBytes+bytes>maxCaptureBytes){stop(Object.assign(new Error("FlashVSR diagnostics exceeded the capture budget."),{code:"FLASHVSR_OUTPUT_LIMIT"}));return;}
      stderrBytes+=bytes;stderr+=chunk.toString();
    });
    child.once("error",error=>finish(stopError||Object.assign(new Error("FlashVSR Python runtime could not be started: "+error.message),{code:"FLASHVSR_RUNTIME_UNAVAILABLE"})));
    child.once("close",(code,signalName)=>stopError?finish(stopError):code===0?finish(null,{stdout,stderr}):finish(Object.assign(new Error("FlashVSR process failed ("+(code??signalName)+"): "+stderr.slice(-1200)),{code:"FLASHVSR_INFERENCE_FAILED"})));
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
  timeoutMs=2*60*60*1000,
  processKillGraceMs=2_000
}={}){
  const root=repoRoot?resolve(repoRoot):"";
  const weights=modelDir?resolve(modelDir):root?join(root,"examples","WanVSR","FlashVSR-v1.1"):"";
  const script=resolve(scriptPath);
  const run=(args,options={})=>runProcess(pythonExecutable,[script,"--repo-root",root,"--model-dir",weights,...args],{spawnImpl,killGraceMs:processKillGraceMs,...options});
  async function probe(){
    if(!root||!weights)return {available:false,executionEnabled:enabled,executionVerified:selfTestPassed,reason:"FLASHVSR_ROOT and model weights are not configured.",model:"FlashVSR-v1.1-tiny-long"};
    const scriptInfo=await lstat(script).catch(()=>null);
    if(!scriptInfo?.isFile()||scriptInfo.isSymbolicLink())return {available:false,executionEnabled:enabled,executionVerified:selfTestPassed,reason:"The isolated FlashVSR bridge script is unavailable.",model:"FlashVSR-v1.1-tiny-long"};
    try{
      const result=await run(["--probe"],{timeoutMs:120_000,maxCaptureBytes:256_000});
      const report=parseLastJson(result.stdout);
      const available=report.available===true;
      return {available,executionEnabled:enabled,executionVerified:selfTestPassed,model:report.model||"FlashVSR-v1.1-tiny-long",license:report.license||"Apache-2.0",runtime:report.runtime||null,checks:report.checks||null,reason:report.reason||(!available?"Python dependencies, CUDA/bfloat16 support or model weights are not ready.":!enabled?"FLASHVSR_ENABLED is not true.":!selfTestPassed?"FLASHVSR_SELF_TEST_PASSED is not true.":null),ready:available&&enabled&&selfTestPassed};
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
