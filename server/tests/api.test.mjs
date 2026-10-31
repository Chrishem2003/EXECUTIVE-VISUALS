import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port=await new Promise(resolve=>{const probe=createServer();probe.listen(0,"127.0.0.1",()=>{const address=probe.address();probe.close(()=>resolve(address.port));});});
const dataDir=await mkdtemp(join(tmpdir(),"ev-api-test-"));
const child=spawn(process.execPath,["server/index.mjs"],{
  cwd:process.cwd(),
  env:{...process.env,NODE_ENV:"development",AUTH_MODE:"local",API_HOST:"127.0.0.1",API_PORT:String(port),DATA_DIR:dataDir,MEDIA_ROOT:join(dataDir,"media"),DISABLE_WORKER:"true"},
  stdio:["ignore","pipe","pipe"]
});
let stdout="",stderr="";
child.stdout.on("data",x=>stdout+=x.toString());
child.stderr.on("data",x=>stderr+=x.toString());
const base="http://127.0.0.1:"+port;
async function waitForApi(){
  for(let i=0;i<80;i++){
    if(child.exitCode!==null)throw new Error("API exited early: "+stderr);
    try{const r=await fetch(base+"/api/health");if(r.ok)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error("API did not start: "+stderr);
}
await waitForApi();

async function expectStatus(response,status){if(response.status!==status)throw new Error("Expected HTTP "+status+", got "+response.status+": "+await response.text());}
async function register(email){
  const r=await fetch(base+"/api/auth/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password:"local-test-password-123"})});
  await expectStatus(r,201);
  return r.headers.get("set-cookie").split(";")[0];
}
async function request(path,options={},cookie){
  return fetch(base+path,{...options,headers:{...(options.headers||{}),...(cookie?{cookie}: {})}});
}

test("health reports local storage and media-engine availability without secrets",async()=>{
  const response=await fetch(base+"/api/health");
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.status,"ok");
  assert.equal(body.storage,"local-disk");
  assert.equal("SUPABASE_SERVICE_ROLE_KEY" in body,false);
});

test("registration, project ownership, binary upload and asset isolation work",async()=>{
  const cookieA=await register("owner-a@example.test");
  const projectResponse=await request("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Test production"})},cookieA);
  assert.equal(projectResponse.status,201);
  const project=(await projectResponse.json()).project;

  const upload=await request("/api/assets",{method:"POST",headers:{"content-type":"image/png","x-file-name":encodeURIComponent("frame.png"),"x-project-id":project.id},body:Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3])},cookieA);
  await expectStatus(upload,201);
  const asset=(await upload.json()).asset;
  assert.equal(asset.name,"frame.png");
  assert.equal(asset.size,12);
  assert.equal(asset.sha256.length,64);

  const assets=await request("/api/assets",{},cookieA);
  assert.equal((await assets.json()).assets.length,1);

  const cookieB=await register("owner-b@example.test");
  const hidden=await request("/api/assets",{},cookieB);
  assert.equal((await hidden.json()).assets.length,0);
  const forbidden=await request("/api/assets/"+asset.id+"/file",{},cookieB);
  assert.equal(forbidden.status,404);
  const ownProject=await request("/api/projects/"+project.id,{},cookieB);
  assert.equal(ownProject.status,404);
});

test("unsupported generation is rejected instead of being represented as a working job",async()=>{
  const cookie=await register("owner-c@example.test");
  const response=await request("/api/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jobType:"video.generate",sourceAssetId:"not-real"})},cookie);
  assert.equal(response.status,409);
  assert.equal((await response.json()).error.code,"ENGINE_UNAVAILABLE");
});

test("local media jobs are queued with idempotency and no duplicate execution",async()=>{
  const cookie=await register("owner-d@example.test");
  const upload=await request("/api/assets",{method:"POST",headers:{"content-type":"video/mp4","x-file-name":"sample.mp4"},body:Buffer.from([0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,0,1])},cookie);
  assert.equal(upload.status,201);
  const asset=(await upload.json()).asset;
  const payload={jobType:"media.probe",sourceAssetId:asset.id};
  const first=await request("/api/jobs",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"probe-001"},body:JSON.stringify(payload)},cookie);
  assert.equal(first.status,202);
  const firstJob=(await first.json()).job;
  assert.equal(firstJob.status,"queued");
  const replay=await request("/api/jobs",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"probe-001"},body:JSON.stringify(payload)},cookie);
  assert.equal(replay.status,200);
  const replayBody=await replay.json();
  assert.equal(replayBody.idempotentReplay,true);
  assert.equal(replayBody.job.id,firstJob.id);
  const events=await request("/api/jobs/"+firstJob.id+"/events",{},cookie);
  assert.ok((await events.json()).events.some(x=>x.type==="job.queued"));
});

test("unauthenticated requests and unsupported upload types are rejected",async()=>{
  const noAuth=await fetch(base+"/api/projects");
  assert.equal(noAuth.status,401);
  const cookie=await register("owner-e@example.test");
  const upload=await request("/api/assets",{method:"POST",headers:{"content-type":"application/x-msdownload","x-file-name":"payload.exe"},body:Buffer.from("no")},cookie);
  assert.equal(upload.status,415);
  const mismatch=await request("/api/assets",{method:"POST",headers:{"content-type":"image/png","x-file-name":"fake.png"},body:Buffer.from("not a PNG signature")},cookie);
  assert.equal(mismatch.status,415);
  assert.equal((await mismatch.json()).error.code,"MEDIA_SIGNATURE_MISMATCH");
});

test.after(async()=>{
  child.kill("SIGTERM");
  await new Promise(resolve=>{const timer=setTimeout(resolve,1500);child.once("exit",()=>{clearTimeout(timer);resolve();});});
  await rm(dataDir,{recursive:true,force:true});
});
