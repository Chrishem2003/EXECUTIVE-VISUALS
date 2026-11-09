import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFlashVsrAdapter } from "../flashvsr-adapter.mjs";

function fakeSpawn(report){
  return (_binary,args)=>{
    const child=new EventEmitter();
    child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
    setImmediate(async()=>{
      const outputIndex=args.indexOf("--output");
      if(outputIndex>=0)await writeFile(args[outputIndex+1],"verified-test-video");
      child.stdout.end(JSON.stringify(report)+"\n");
      child.stderr.end();
      child.emit("close",0,null);
    });
    return child;
  };
}

function stubbornSpawn(signals){
  return ()=>{
    const child=new EventEmitter();
    child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=signal=>{signals.push(signal);if(signal==="SIGKILL")setImmediate(()=>child.emit("close",null,"SIGKILL"));return true;};
    return child;
  };
}
const readyReport={available:true,model:"FlashVSR-v1.1-tiny-long",license:"Apache-2.0",runtime:{cuda:true,bfloat16:true},checks:{upstream_script:true},executionVerified:false};

test("FlashVSR readiness requires installed runtime, explicit enablement and self-test",async()=>{
  const adapter=createFlashVsrAdapter({pythonExecutable:"python-test",repoRoot:tmpdir(),modelDir:tmpdir(),scriptPath:fileURLToPath(import.meta.url),enabled:true,selfTestPassed:true,spawnImpl:fakeSpawn(readyReport)});
  const result=await adapter.probe();
  assert.equal(result.available,true);
  assert.equal(result.executionEnabled,true);
  assert.equal(result.executionVerified,true);
  assert.equal(result.ready,true);
  assert.equal(result.license,"Apache-2.0");
});

test("FlashVSR inference refuses to run without explicit enablement and self-test",async()=>{
  const adapter=createFlashVsrAdapter({repoRoot:tmpdir(),modelDir:tmpdir(),scriptPath:fileURLToPath(import.meta.url),enabled:true,selfTestPassed:false,spawnImpl:fakeSpawn({ok:true,model:"FlashVSR-v1.1-tiny-long",frames:8,scale:4,temporalModel:true})});
  await assert.rejects(adapter.execute({inputPath:"/tmp/input.mp4",outputPath:"/tmp/output.mp4",scale:4}),error=>error.code==="FLASHVSR_NOT_ENABLED");
});

test("FlashVSR inference validates model result and output file before returning",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"flashvsr-adapter-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const input=join(dir,"input.mp4"),output=join(dir,"output.mp4");await writeFile(input,"source");
  const adapter=createFlashVsrAdapter({repoRoot:dir,modelDir:dir,scriptPath:fileURLToPath(import.meta.url),enabled:true,selfTestPassed:true,spawnImpl:fakeSpawn({ok:true,model:"FlashVSR-v1.1-tiny-long",frames:8,scale:4,temporalModel:true,license:"Apache-2.0"})});
  const result=await adapter.execute({inputPath:input,outputPath:output,scale:4});
  assert.equal(result.temporalModel,true);
  assert.equal((await readFile(output)).toString(),"verified-test-video");
  await assert.rejects(adapter.execute({inputPath:input,outputPath:join(dir,"bad.mp4"),scale:2}),error=>error.code==="FLASHVSR_SCALE_UNSUPPORTED");
});

test("FlashVSR rejects a subprocess response that does not prove temporal-model execution",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"flashvsr-adapter-invalid-"));t.after(()=>rm(dir,{recursive:true,force:true}));
  const input=join(dir,"input.mp4"),output=join(dir,"output.mp4");await writeFile(input,"source");
  const adapter=createFlashVsrAdapter({repoRoot:dir,modelDir:dir,scriptPath:fileURLToPath(import.meta.url),enabled:true,selfTestPassed:true,spawnImpl:fakeSpawn({ok:true,model:"FlashVSR-v1.1-tiny-long",frames:8,scale:4,temporalModel:false})});
  await assert.rejects(adapter.execute({inputPath:input,outputPath:output,scale:4}),error=>error.code==="FLASHVSR_OUTPUT_INVALID");
});

test("FlashVSR timeout escalates an unresponsive worker from SIGTERM to SIGKILL",async()=>{
  const signals=[];
  const adapter=createFlashVsrAdapter({repoRoot:tmpdir(),modelDir:tmpdir(),scriptPath:fileURLToPath(import.meta.url),enabled:true,selfTestPassed:true,timeoutMs:5,processKillGraceMs:5,spawnImpl:stubbornSpawn(signals)});
  await assert.rejects(adapter.execute({inputPath:"/tmp/input.mp4",outputPath:"/tmp/output.mp4",scale:4}),error=>error.code==="FLASHVSR_TIMEOUT");
  assert.deepEqual(signals,["SIGTERM","SIGKILL"]);
});

test("FlashVSR cancellation escalates an unresponsive worker and preserves cancellation status",async()=>{
  const signals=[],controller=new AbortController();
  const adapter=createFlashVsrAdapter({repoRoot:tmpdir(),modelDir:tmpdir(),scriptPath:fileURLToPath(import.meta.url),enabled:true,selfTestPassed:true,timeoutMs:60_000,processKillGraceMs:5,spawnImpl:stubbornSpawn(signals)});
  const pending=adapter.execute({inputPath:"/tmp/input.mp4",outputPath:"/tmp/output.mp4",scale:4,signal:controller.signal});
  controller.abort();
  await assert.rejects(pending,error=>error.code==="JOB_CANCELLED");
  assert.deepEqual(signals,["SIGTERM","SIGKILL"]);
});
