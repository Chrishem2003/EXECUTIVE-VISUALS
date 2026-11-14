import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLpipsPerceptualAssessor } from "../lpips-perceptual-assessor.mjs";

const report = {
  ok:true,metric:"LPIPS",version:"0.1",network:"alex",device:"cpu",
  distance:0.2,width:64,height:64,modelDownloadsAllowed:false
};
function fakeSpawn(payload=report, observed={}) {
  return (binary,args,options) => {
    observed.binary=binary;observed.args=args;observed.options=options;
    const child=new EventEmitter();
    child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>true;
    process.nextTick(()=>{child.stdout.end(JSON.stringify(payload));child.stderr.end();child.emit("close",0);});
    return child;
  };
}
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),"ev-lpips-test-"));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const candidatePath=join(root,"candidate.png"),referencePath=join(root,"reference.png");
  await writeFile(candidatePath,"candidate");
  await writeFile(referencePath,"reference");
  return {root,candidatePath,referencePath};
}

test("LPIPS runs only as an offline paired-reference assessment with bounded process settings",async t=>{
  const {candidatePath,referencePath}=await fixture(t),observed={};
  const assessor=createLpipsPerceptualAssessor({pythonPath:"python-test",spawnProcess:fakeSpawn(report,observed)});
  const result=await assessor.assess({candidatePath,referencePath});
  assert.equal(result.metric,"LPIPS");
  assert.equal(result.distance,0.2);
  assert.equal(result.interpretation,"lower_is_more_perceptually_similar");
  assert.equal(result.modelDownloadsAllowed,false);
  assert.equal(observed.binary,"python-test");
  assert.equal(observed.options.shell,false);
  assert.equal(observed.options.env.HF_HUB_OFFLINE,"1");
  assert.equal(observed.options.env.TRANSFORMERS_OFFLINE,"1");
  assert.ok(observed.args.includes("--candidate"));
  assert.ok(observed.args.includes("--reference"));
});

test("LPIPS refuses missing references and symlinked image inputs before launching Python",async t=>{
  const {candidatePath,referencePath,root}=await fixture(t);let launches=0;
  const assessor=createLpipsPerceptualAssessor({spawnProcess(){launches++;}});
  await assert.rejects(assessor.assess({candidatePath}),error=>error.code==="AI_UPSCALE_LPIPS_REFERENCE_REQUIRED");
  const link=join(root,"candidate-link.png");await symlink(candidatePath,link);
  await assert.rejects(assessor.assess({candidatePath:link,referencePath}),error=>error.code==="AI_UPSCALE_LPIPS_INVALID");
  assert.equal(launches,0);
});

test("LPIPS rejects invalid worker responses instead of trusting arbitrary scores",async t=>{
  const {candidatePath,referencePath}=await fixture(t);
  const assessor=createLpipsPerceptualAssessor({spawnProcess:fakeSpawn({...report,distance:NaN})});
  await assert.rejects(assessor.assess({candidatePath,referencePath}),error=>error.code==="AI_UPSCALE_LPIPS_PROTOCOL");
});

test("LPIPS propagates cancellation and terminates the child process",async t=>{
  const {candidatePath,referencePath}=await fixture(t),controller=new AbortController();
  let killed=false;
  const assessor=createLpipsPerceptualAssessor({spawnProcess:(_binary,_args)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>{killed=true;return true;};return child;
  }});
  const pending=assessor.assess({candidatePath,referencePath,signal:controller.signal});
  await new Promise(resolve=>setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending,error=>error.code==="JOB_CANCELLED");
  assert.equal(killed,true);
});

test("LPIPS validates model, device and resource budgets at construction",()=>{
  assert.throws(()=>createLpipsPerceptualAssessor({network:"unknown"}),/network/);
  assert.throws(()=>createLpipsPerceptualAssessor({device:"tpu"}),/device/);
  assert.throws(()=>createLpipsPerceptualAssessor({maxPixels:16_000_001}),/pixel limit/);
  assert.throws(()=>createLpipsPerceptualAssessor({threads:0}),/thread count/);
});
