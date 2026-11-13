import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, json } from "../db.mjs";

const port=await new Promise(resolve=>{const probe=createServer();probe.listen(0,"127.0.0.1",()=>{const address=probe.address();probe.close(()=>resolve(address.port));});});
const d1ProxyPort=await new Promise(resolve=>{const probe=createServer();probe.listen(0,"127.0.0.1",()=>{const address=probe.address();probe.close(()=>resolve(address.port));});});
const d1ProxyRequests=[];
const d1ProxyServer=createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const raw=Buffer.concat(chunks).toString("utf8");
  d1ProxyRequests.push({method:req.method,path:req.url,cookie:req.headers.cookie||"",body:raw});
  res.writeHead(req.method==="POST"?201:200,{"content-type":"application/json","cache-control":"no-store"});
  res.end(JSON.stringify(req.method==="POST"?{project:{id:"staging-project",name:JSON.parse(raw).name},storage:"cloudflare-d1-staging"}:{projects:[],storage:"cloudflare-d1-staging"}));
});
await new Promise(resolve=>d1ProxyServer.listen(d1ProxyPort,"127.0.0.1",resolve));
const dataDir=await mkdtemp(join(tmpdir(),"ev-api-test-"));
const webDir=join(dataDir,"web");await mkdir(webDir,{recursive:true});await writeFile(join(webDir,"index.html"),"<!doctype html><html><body>test</body></html>");
const child=spawn(process.execPath,["server/index.mjs"],{
  cwd:process.cwd(),
  env:{...process.env,NODE_ENV:"development",AUTH_MODE:"local",AUTH_RATE_LIMIT:"1000",REMOTE_AI_DAILY_REQUEST_LIMIT:"7",API_HOST:"127.0.0.1",API_PORT:String(port),DATA_DIR:dataDir,MEDIA_ROOT:join(dataDir,"media"),WEB_ROOT:webDir,VIDEO_MODEL_PRICING_JSON:JSON.stringify([{provider:"fal",model:"fal-ai/example-video",currency:"USD",sourceUrl:"https://fal.ai/pricing",observedAt:"2026-11-01T00:00:00.000Z",expiresAt:"2026-12-01T00:00:00.000Z",ratesPerSecond:{"720p":0.12},audioSurchargePerSecond:0.02,referenceImageFee:0.03,billingIncrementSeconds:1}]),AI_UPSCALE_QUALITY_EVIDENCE_PATH:"",DISABLE_WORKER:"true",D1_STAGING_WORKER_URL:"http://127.0.0.1:"+d1ProxyPort},
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
  assert.deepEqual(body.persistence,{dataDirectory:"ephemeral",persistentVolumeRequired:false});
  assert.equal(body.cloudVideoWorker.enabled,false);
  assert.equal(body.cloudVideoWorker.runtimeMode,"separate-process");
  assert.equal(typeof body.cloudVideoWorker.providerCredentialConfigured,"boolean");
  assert.equal("SUPABASE_SERVICE_ROLE_KEY" in body,false);
  assert.equal("RUNWAY_API_KEY" in body.cloudVideoWorker,false);
  assert.equal(response.headers.get("x-frame-options"),"DENY");
  assert.equal(response.headers.get("referrer-policy"),"strict-origin-when-cross-origin");
});

test("D1 staging bridge is same-origin, authenticated and forwards the existing session cookie",async()=>{
  const anonymous=await fetch(base+"/api/d1/projects");
  assert.equal(anonymous.status,401);
  assert.equal(d1ProxyRequests.length,0,"anonymous callers must not reach the staging Worker");

  const cookie=await register("d1-staging-proxy@example.test");
  const list=await request("/api/d1/projects",{},cookie);
  assert.equal(list.status,200);
  assert.deepEqual(await list.json(),{projects:[],storage:"cloudflare-d1-staging"});
  assert.equal(d1ProxyRequests.at(-1).method,"GET");
  assert.match(d1ProxyRequests.at(-1).cookie,/ev_session=/);

  const create=await request("/api/d1/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Connected staging workspace"})},cookie);
  assert.equal(create.status,201);
  assert.equal((await create.json()).project.name,"Connected staging workspace");
  assert.deepEqual(JSON.parse(d1ProxyRequests.at(-1).body),{name:"Connected staging workspace"});
  assert.match(d1ProxyRequests.at(-1).cookie,/ev_session=/);
});

test("provider catalog is authenticated, safe and read-only",async()=>{
  const anonymous=await fetch(base+"/api/providers");
  assert.equal(anonymous.status,401);
  const cookie=await register("provider-owner@example.test");
  const response=await request("/api/providers",{},cookie);
  assert.equal(response.status,200);
  const catalog=await response.json();
  assert.equal(catalog.version,1);
  assert.equal(catalog.providers.length,7);
  assert.equal(catalog.policy.requestsSubmitted,false);
  assert.equal(catalog.policy.credentialsExposed,false);
  assert.equal(catalog.policy.pricesEstimated,false);
  assert.equal(catalog.policy.pricingSchedulesConfigured,true);
  assert.equal(catalog.providers.find(item=>item.id==="video").pricing.models[0].model,"fal-ai/example-video");
  assert.equal(JSON.stringify(catalog).includes("API_KEY"),false);
  assert.equal(JSON.stringify(catalog).includes("Bearer "),false);
});


test("video cost estimate API is authenticated, read-only and uses configured model pricing",async()=>{
  assert.equal((await fetch(base+"/api/video-cost-estimate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"fal",model:"fal-ai/example-video",durationSeconds:5,resolution:"720p",audioMode:"generated",referenceImageCount:1})})).status,401);
  const cookie=await register("video-cost-owner@example.test");
  const response=await request("/api/video-cost-estimate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"fal",model:"fal-ai/example-video",durationSeconds:5,resolution:"720p",audioMode:"generated",referenceImageCount:1})},cookie);
  assert.equal(response.status,200);
  const quote=await response.json();
  assert.equal(quote.available,true);
  assert.equal(quote.estimated,true);
  assert.equal(quote.amount,0.73);
  assert.equal(quote.currency,"USD");
  assert.equal(quote.pricing.sourceUrl,"https://fal.ai/pricing");
  assert.equal(quote.breakdown.video,0.6);
  assert.equal(quote.breakdown.audio,0.1);
  assert.equal(quote.breakdown.references,0.03);
  assert.equal(quote.disclaimer.includes("Estimate only"),true);
  const unknown=await request("/api/video-cost-estimate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"fal",model:"unknown",durationSeconds:5})},cookie);
  assert.equal((await unknown.json()).available,false);
});

test("multi-shot production quote API is authenticated, itemized and read-only",async()=>{
  assert.equal((await fetch(base+"/api/video-production-quote",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({shots:[]})})).status,401);
  const cookie=await register("production-quote-owner@example.test");
  const response=await request("/api/video-production-quote",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({shots:[
    {id:"opening",provider:"fal",model:"fal-ai/example-video",durationSeconds:5,resolution:"720p",audioMode:"generated",referenceImageCount:1},
    {id:"close",provider:"fal",model:"fal-ai/example-video",durationSeconds:3,resolution:"720p",audioMode:"none",referenceImageCount:0}
  ]})},cookie);
  assert.equal(response.status,200);
  const quote=await response.json();
  assert.equal(quote.available,true);
  assert.equal(quote.shotCount,2);
  assert.equal(quote.totalDurationSeconds,8);
  assert.equal(quote.amount,1.09);
  assert.equal(quote.shots.length,2);
  assert.equal(quote.breakdown.minimumApplied,0);
  assert.equal(quote.disclaimer.includes("No generation jobs were submitted"),true);
});

test("capability atlas is authenticated, read-only and distinguishes implemented from unavailable operations",async()=>{
  assert.equal((await fetch(base+"/api/capabilities")).status,401);
  const cookie=await register("capability-atlas-owner@example.test");
  const response=await request("/api/capabilities",{},cookie);
  assert.equal(response.status,200);
  const atlas=await response.json();
  assert.equal(atlas.version,2);
  assert.equal(atlas.summary.implementedOperations,2);
  assert.equal(atlas.summary.documentedNotIntegrated,10);
  assert.equal(atlas.providers[0].policy.requestsSubmitted,false);
  assert.equal(atlas.providers[0].policy.credentialsExposed,false);
  assert.equal(atlas.providers[0].operations.find(x=>x.id==="video.video_to_video").status,"documented_not_integrated");
});
test("usage API reports account request allowance without exposing secrets",async()=>{
  assert.equal((await fetch(base+"/api/usage")).status,401);
  const cookie=await register("usage-owner@example.test");
  const response=await request("/api/usage",{},cookie);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.deepEqual(body.remoteUsage,{
    window:"rolling_24_hours",configurationValid:true,limit:7,used:0,remaining:7,projectUsed:null,remoteDisabled:false
  });
  assert.equal(body.costs,"not_estimated");
  assert.equal(JSON.stringify(body).includes("REMOTE_AI_DAILY_REQUEST_LIMIT"),false);
});

test("static application shell applies a restrictive content security policy",async()=>{
  const response=await fetch(base+"/");
  assert.equal(response.status,200);
  const policy=response.headers.get("content-security-policy")||"";
  assert.ok(policy.includes("script-src 'self'"));
  assert.ok(policy.includes("frame-ancestors 'none'"));
  assert.ok(policy.includes("object-src 'none'"));
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
  assert.equal(asset.provenance.schema,"executive-visuals.provenance.v1");
  assert.equal(asset.provenance.asset.sha256,asset.sha256);
  const provenance=await request("/api/assets/"+asset.id+"/provenance",{},cookieA);
  assert.equal(provenance.status,200);
  const provenanceBody=await provenance.json();
  assert.equal(provenanceBody.verification.status,"integrity_verified");
  assert.equal(provenanceBody.verification.c2pa,"not_checked");
  const c2pa=await request("/api/assets/"+asset.id+"/c2pa",{},cookieA);
  assert.equal(c2pa.status,200,await c2pa.clone().text());
  const c2paBody=await c2pa.json();
  assert.equal(c2paBody.assetId,asset.id);
  assert.ok(["not_present","invalid","valid_untrusted","trusted","validation_unavailable"].includes(c2paBody.verification.status));

  const assets=await request("/api/assets",{},cookieA);
  assert.equal((await assets.json()).assets.length,1);

  const cookieB=await register("owner-b@example.test");
  const hidden=await request("/api/assets",{},cookieB);
  assert.equal((await hidden.json()).assets.length,0);
  const forbidden=await request("/api/assets/"+asset.id+"/file",{},cookieB);
  assert.equal(forbidden.status,404);
  const hiddenProvenance=await request("/api/assets/"+asset.id+"/provenance",{},cookieB);
  assert.equal(hiddenProvenance.status,404);
  const hiddenC2pa=await request("/api/assets/"+asset.id+"/c2pa",{},cookieB);
  assert.equal(hiddenC2pa.status,404);
  const ownProject=await request("/api/projects/"+project.id,{},cookieB);
  assert.equal(ownProject.status,404);
});

test("creative workspace drafts persist per project with revision and editor-role guards",async()=>{
  const owner=await register("workspace-owner@example.test");
  const created=await request("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Persistent creative workspace"})},owner);
  assert.equal(created.status,201);
  const project=(await created.json()).project;
  const initial=await request("/api/projects/"+project.id+"/workspace",{},owner);
  assert.equal(initial.status,200);
  assert.equal((await initial.json()).revision,0);
  const document={
    creativeProjects:[{id:"draft-1",name:"Launch film",brief:"A durable creative brief",audience:"Customers",style:"Documentary",created:"2026-10-31"}],
    tasks:[{id:"task-1",name:"Build storyboard",category:"Pre-production",status:"planned",created:"2026-10-31",detail:"Create scene cards"}],
    shots:[{id:"shot-1",scene:"Opening",action:"Aerial approach",camera:"Wide",lens:"24mm",movement:"Slow push",lighting:"Golden hour",duration:5,characterIds:["character-1"],location:"Lake shore",timeOfDay:"Sunrise",visualPrompt:"Maintain the same jacket and hairstyle",continuityIn:"Character enters from frame left",continuityOut:"Camera settles on the shoreline",referenceAssetIds:["asset-ref-1"],aspectRatio:"16:9"}],
    characters:[{id:"character-1",name:"Presenter",description:"Original fictional presenter",voice:"Not assigned",appearance:"Short dark hair; distinctive round glasses",wardrobe:"Navy jacket, white shirt",voiceProfile:"Warm mid-range delivery; measured pace",continuityNotes:"Keep glasses and hairstyle unchanged across scenes",referenceAssetIds:["asset-ref-1","asset-ref-2"],consent:{kind:"authorized",scopes:["likeness","voice"],evidenceReference:"release-record-7",expiresAt:"2027-06-30"}}],
    prompt:"Creative brief prompt",plan:"Three-act plan",script:"Opening narration",variants:["A","B"],
    researchSources:[{id:"source-1",title:"Official evidence report",url:"https://example.org/report",sourceType:"Official report",author:"Research Office",summary:"Primary evidence",rights:"Public"}],
    knowledgeRecords:[{id:"record-1",title:"Verified finding",content:"Finding supported by the official report.",tags:["evidence"],sourceIds:["source-1","unknown-source"],kind:"Finding",status:"Verified"}],
    ignoredSecret:"must not be persisted"
  };
  const saved=await request("/api/projects/"+project.id+"/workspace",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:0,document})},owner);
  assert.equal(saved.status,200);
  assert.equal((await saved.json()).revision,1);
  const loaded=await request("/api/projects/"+project.id+"/workspace",{},owner);
  const loadedBody=await loaded.json();
  assert.equal(loadedBody.revision,1);
  assert.equal(loadedBody.document.creativeProjects[0].name,"Launch film");
  assert.equal(loadedBody.document.shots[0].duration,5);
  assert.deepEqual(loadedBody.document.shots[0].characterIds,["character-1"]);
  assert.equal(loadedBody.document.shots[0].location,"Lake shore");
  assert.equal(loadedBody.document.shots[0].continuityOut,"Camera settles on the shoreline");
  assert.deepEqual(loadedBody.document.shots[0].referenceAssetIds,["asset-ref-1"]);
  assert.equal(loadedBody.document.shots[0].aspectRatio,"16:9");
  assert.equal(loadedBody.document.characters[0].wardrobe,"Navy jacket, white shirt");
  assert.equal(loadedBody.document.characters[0].voiceProfile,"Warm mid-range delivery; measured pace");
  assert.deepEqual(loadedBody.document.characters[0].referenceAssetIds,["asset-ref-1","asset-ref-2"]);
  assert.deepEqual(loadedBody.document.characters[0].consent,{kind:"authorized",scopes:["likeness","voice"],evidenceReference:"release-record-7",expiresAt:"2027-06-30"});
  assert.equal(loadedBody.document.researchSources[0].url,"https://example.org/report");
  assert.deepEqual(loadedBody.document.knowledgeRecords[0].sourceIds,["source-1"]);
  assert.equal("ignoredSecret" in loadedBody.document,false);
  const unsafe=await request("/api/projects/"+project.id+"/workspace",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:1,document:{researchSources:[{id:"bad",title:"Unsafe",url:"javascript:alert(1)"}]}})},owner);
  assert.equal(unsafe.status,400);
  assert.equal((await unsafe.json()).error.code,"INVALID_RESEARCH_SOURCE_URL");
  const blockedImport=await request("/api/projects/"+project.id+"/research/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({revision:1,url:"https://127.0.0.1/private"})},owner);
  assert.equal(blockedImport.status,400);
  assert.equal((await blockedImport.json()).error.code,"UNSAFE_RESEARCH_URL");
  const afterBlockedImport=await request("/api/projects/"+project.id+"/workspace",{},owner);
  assert.equal((await afterBlockedImport.json()).revision,1,"rejected private-network imports must not change project revision");
  const ungrounded=await request("/api/projects/"+project.id+"/workspace",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:1,document:{knowledgeRecords:[{id:"ungrounded",title:"Unsupported claim",content:"No source attached.",kind:"Finding",status:"Verified",sourceIds:[]}]}})},owner);
  assert.equal(ungrounded.status,400);
  assert.equal((await ungrounded.json()).error.code,"KNOWLEDGE_EVIDENCE_REQUIRED");
  const stale=await request("/api/projects/"+project.id+"/workspace",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:0,document})},owner);
  assert.equal(stale.status,409);
  const editor=await register("workspace-editor@example.test");
  const viewer=await register("workspace-viewer@example.test");
  await request("/api/projects/"+project.id+"/members",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"workspace-editor@example.test",role:"editor"})},owner);
  await request("/api/projects/"+project.id+"/members",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"workspace-viewer@example.test",role:"viewer"})},owner);
  const editorSave=await request("/api/projects/"+project.id+"/workspace",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:1,document:{knowledgeRecords:[{id:"record-2",title:"Collaborator note",content:"Partial workspace save.",tags:[],sourceIds:["source-1"],kind:"Decision",status:"Draft"}]}})},editor);
  assert.equal(editorSave.status,200);
  assert.equal((await editorSave.json()).revision,2);
  const merged=await request("/api/projects/"+project.id+"/workspace",{},owner);
  const mergedDoc=(await merged.json()).document;
  assert.equal(mergedDoc.creativeProjects[0].name,"Launch film","partial knowledge saves preserve creative project data");
  assert.equal(mergedDoc.researchSources[0].title,"Official evidence report","partial knowledge saves preserve source records");
  assert.equal(mergedDoc.knowledgeRecords[0].title,"Collaborator note");
  const viewerImport=await request("/api/projects/"+project.id+"/research/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({revision:2,url:"https://example.org/report"})},viewer);
  assert.equal(viewerImport.status,403,"viewers cannot trigger outbound research imports");
  const viewerSave=await request("/api/projects/"+project.id+"/workspace",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:2,document})},viewer);
  assert.equal(viewerSave.status,403);
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
  const oversized=await request("/api/jobs",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"x".repeat(181)},body:JSON.stringify(payload)},cookie);
  assert.equal(oversized.status,400);
  assert.equal((await oversized.json()).error.code,"INVALID_IDEMPOTENCY_KEY");
  const first=await request("/api/jobs",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"probe-001"},body:JSON.stringify(payload)},cookie);
  assert.equal(first.status,202);
  const firstJob=(await first.json()).job;
  assert.equal(firstJob.status,"queued");
  const replay=await request("/api/jobs",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"probe-001"},body:JSON.stringify(payload)},cookie);
  assert.equal(replay.status,200);
  const replayBody=await replay.json();
  assert.equal(replayBody.idempotentReplay,true);
  assert.equal(replayBody.job.id,firstJob.id);
  const conflictingReplay=await request("/api/jobs",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"probe-001"},body:JSON.stringify({jobType:"media.thumbnail",sourceAssetId:asset.id})},cookie);
  assert.equal(conflictingReplay.status,409);
  assert.equal((await conflictingReplay.json()).error.code,"IDEMPOTENCY_CONFLICT");
  const events=await request("/api/jobs/"+firstJob.id+"/events",{},cookie);
  assert.ok((await events.json()).events.some(x=>x.type==="job.queued"));
});

test("AI upscale job submission is rejected until the selected model has its own reviewed benchmark",async()=>{
  const cookie=await register("upscale-quality-gate@example.test");
  const png=Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(png,0);
  png.writeUInt32BE(13,8);png.write("IHDR",12,"ascii");png.writeUInt32BE(1,16);png.writeUInt32BE(1,20);
  const upload=await request("/api/assets",{method:"POST",headers:{"content-type":"image/png","x-file-name":"quality-gate.png"},body:png},cookie);
  assert.equal(upload.status,201);
  const asset=(await upload.json()).asset;
  const response=await request("/api/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jobType:"media.ai-upscale",sourceAssetId:asset.id,model:"realesrgan-x4plus-anime",scale:4})},cookie);
  assert.equal(response.status,409);
  assert.equal((await response.json()).error.code,"AI_UPSCALE_QUALITY_NOT_VERIFIED");
});
 
test("AI video upscale is recognized but fails closed until its model has reviewed quality evidence",async()=>{
  const cookie=await register("video-upscale-quality-gate@example.test");
  const mp4=Buffer.alloc(24);
  mp4.writeUInt32BE(24,0);mp4.write("ftyp",4,"ascii");mp4.write("isom",8,"ascii");mp4.writeUInt32BE(0,12);mp4.write("isom",16,"ascii");
  const upload=await request("/api/assets",{method:"POST",headers:{"content-type":"video/mp4","x-file-name":"video-quality-gate.mp4"},body:mp4},cookie);
  assert.equal(upload.status,201);
  const asset=(await upload.json()).asset;
  const response=await request("/api/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jobType:"media.video-ai-upscale",sourceAssetId:asset.id,model:"realesrgan-x4plus",scale:2})},cookie);
  assert.equal(response.status,409);
  assert.equal((await response.json()).error.code,"AI_UPSCALE_QUALITY_NOT_VERIFIED");
  const jobs=await request("/api/jobs",{},cookie);
  assert.equal((await jobs.json()).jobs.filter(job=>job.jobType==="media.video-ai-upscale").length,0,"unverified video requests must not enqueue jobs");
});

test("batch AI upscaling validates image ownership and fails closed before queueing unverified models",async()=>{
  assert.equal((await fetch(base+"/api/jobs/batch",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({items:[]})})).status,401);
  const cookie=await register("batch-upscale-gate@example.test");
  const empty=await request("/api/jobs/batch",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({items:[]})},cookie);
  assert.equal(empty.status,400);
  assert.equal((await empty.json()).error.code,"INVALID_BATCH");

  const png=Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  png.writeUInt32BE(13,8);png.write("IHDR",12,"ascii");png.writeUInt32BE(1,16);png.writeUInt32BE(1,20);
  const upload=await request("/api/assets",{method:"POST",headers:{"content-type":"image/png","x-file-name":"batch-source.png"},body:png},cookie);
  assert.equal(upload.status,201);
  const asset=(await upload.json()).asset;

  const duplicate=await request("/api/jobs/batch",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({items:[{sourceAssetId:asset.id},{sourceAssetId:asset.id}]})},cookie);
  assert.equal(duplicate.status,400);
  assert.equal((await duplicate.json()).error.code,"INVALID_BATCH_ITEM");

  const oversized=await request("/api/jobs/batch",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"x".repeat(181)},body:JSON.stringify({items:[{sourceAssetId:asset.id}]})},cookie);
  assert.equal(oversized.status,400);
  assert.equal((await oversized.json()).error.code,"INVALID_IDEMPOTENCY_KEY");

  const blocked=await request("/api/jobs/batch",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"batch-quality-gate-001"},body:JSON.stringify({items:[{sourceAssetId:asset.id}]})},cookie);
  assert.equal(blocked.status,409);
  assert.equal((await blocked.json()).error.code,"AI_UPSCALE_QUALITY_NOT_VERIFIED");
  const jobs=await request("/api/jobs",{},cookie);
  assert.equal((await jobs.json()).jobs.filter(job=>job.jobType==="media.ai-upscale").length,0,"unverified batch requests must not enqueue jobs");
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


test("workflow graphs are validated, versioned and owner-scoped",async()=>{
  const cookie=await register("workflow-owner@example.test");
  const graph={
    id:"workflow-1",projectId:"local",revision:1,
    nodes:[
      {id:"brief",kind:"text",label:"Brief",inputs:[],outputs:[{id:"text",type:"text"}],config:{}},
      {id:"writer",kind:"llm.prompt",label:"Writer",inputs:[{id:"prompt",type:"text",required:true}],outputs:[{id:"script",type:"script"}],config:{}}
    ],
    edges:[{id:"edge-1",sourceNodeId:"brief",sourcePortId:"text",targetNodeId:"writer",targetPortId:"prompt"}]
  };
  const created=await request("/api/workflows",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Episode pipeline",graph})},cookie);
  assert.equal(created.status,201,await created.clone().text());
  const workflow=(await created.json()).workflow;
  assert.equal(workflow.graph.id,workflow.id,"server workflow ID and graph ID must match");
  const runResponse=await request("/api/workflows/"+workflow.id+"/run",{method:"POST"},cookie);
  assert.equal(runResponse.status,202);
  const run=(await runResponse.json());
  assert.equal(run.status,"queued");
  const runRead=await request("/api/workflow-runs/"+run.runId,{},cookie);
  assert.equal(runRead.status,200);
  assert.equal((await runRead.json()).run.status,"queued");
  const runList=await request("/api/workflows/"+workflow.id+"/runs",{},cookie);
  assert.equal((await runList.json()).runs.length,1);
  const read=await request("/api/workflows/"+workflow.id,{},cookie);
  assert.equal(read.status,200);
  const readBody=await read.json();
  assert.equal(readBody.workflow.graphHash,workflow.graphHash);
  assert.equal(readBody.workflow.graph.id,workflow.id);
  const updated=await request("/api/workflows/"+workflow.id,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:1,name:"Episode pipeline v2",graph})},cookie);
  assert.equal(updated.status,200);
  assert.equal((await updated.json()).revision,2);
  const stale=await request("/api/workflows/"+workflow.id,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:1,graph})},cookie);
  assert.equal(stale.status,409);
  const cycle={
    nodes:[
      {id:"a",inputs:[{id:"in",type:"text",required:true}],outputs:[{id:"out",type:"text"}],config:{}},
      {id:"b",inputs:[{id:"in",type:"text",required:true}],outputs:[{id:"out",type:"text"}],config:{}}
    ],
    edges:[
      {id:"ab",sourceNodeId:"a",sourcePortId:"out",targetNodeId:"b",targetPortId:"in"},
      {id:"ba",sourceNodeId:"b",sourcePortId:"out",targetNodeId:"a",targetPortId:"in"}
    ]
  };
  const invalid=await request("/api/workflows",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Cycle",graph:cycle})},cookie);
  assert.equal(invalid.status,422);
  assert.equal((await invalid.json()).error.code,"WORKFLOW_INVALID");
  const other=await register("workflow-other@example.test");
  const hidden=await request("/api/workflows/"+workflow.id,{},other);
  assert.equal(hidden.status,404);
});


test("workflow runs snapshot revisions, plan partial targets and isolate node history",async()=>{
  const owner=await register("workflow-run-owner@example.test");
  const upload=await request("/api/assets",{method:"POST",headers:{"content-type":"image/png","x-file-name":"run-source.png"},body:Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3])},owner);
  assert.equal(upload.status,201);
  const asset=(await upload.json()).asset;
  const graph={
    id:"run-graph",projectId:null,revision:1,
    nodes:[
      {id:"source",kind:"upload",label:"Source asset",inputs:[],outputs:[{id:"asset",type:"asset"},{id:"media",type:"media"}],config:{assetId:asset.id},locked:true,lockedOutputIds:[asset.id]},
      {id:"approval",kind:"approval",label:"Human approval",inputs:[{id:"media",type:"media",required:true}],outputs:[{id:"media",type:"media"}],config:{}},
      {id:"export",kind:"export",label:"Export",inputs:[{id:"media",type:"media",required:true}],outputs:[{id:"deliverable",type:"asset"}],config:{}}
    ],
    edges:[
      {id:"source-approval",sourceNodeId:"source",sourcePortId:"media",targetNodeId:"approval",targetPortId:"media"},
      {id:"approval-export",sourceNodeId:"approval",sourcePortId:"media",targetNodeId:"export",targetPortId:"media"}
    ]
  };
  const created=await request("/api/workflows",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Approval pipeline",graph})},owner);
  assert.equal(created.status,201,await created.clone().text());
  const workflow=(await created.json()).workflow;
  const runResponse=await request("/api/workflows/"+workflow.id+"/run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({target:{kind:"node",nodeId:"export"}})},owner);
  assert.equal(runResponse.status,202,await runResponse.clone().text());
  const run=(await runResponse.json());
  assert.deepEqual(run.executionOrder,["source","approval","export"]);
  assert.deepEqual(run.reusedNodeIds,["source"]);
  const detailResponse=await request("/api/workflow-runs/"+run.runId,{},owner);
  assert.equal(detailResponse.status,200);
  const detail=await detailResponse.json();
  assert.equal(detail.run.revision,1);
  assert.equal(detail.run.snapshotHash,run.snapshotHash);
  assert.equal(detail.run.status,"queued");
  assert.deepEqual(detail.run.target,{kind:"node",nodeId:"export"});
  assert.equal(detail.nodes.length,3);
  assert.equal(detail.nodes.find(node=>node.node_id==="source").status,"skipped");
  assert.equal(detail.nodes.find(node=>node.node_id==="approval").status,"pending");

  const changedGraph={...graph,nodes:graph.nodes.map(node=>node.id==="export"?{...node,label:"Updated export"}:node)};
  const update=await request("/api/workflows/"+workflow.id,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:1,name:"Approval pipeline v2",graph:changedGraph})},owner);
  assert.equal(update.status,200);
  const after=await request("/api/workflow-runs/"+run.runId,{},owner);
  const afterBody=await after.json();
  assert.equal(afterBody.run.revision,1,"run keeps the source workflow revision");
  assert.equal(afterBody.run.snapshotHash,run.snapshotHash,"later workflow edits cannot mutate the run snapshot");
  const other=await register("workflow-run-other@example.test");
  const hidden=await request("/api/workflow-runs/"+run.runId,{},other);
  assert.equal(hidden.status,404);
  const runs=await request("/api/workflows/"+workflow.id+"/runs",{},owner);
  assert.ok((await runs.json()).runs.some(item=>item.id===run.runId));
});


test("workflow approval endpoint resumes a paused immutable run",async()=>{
  const cookie=await register("workflow-approval@example.test");
  const graph={id:"approval-graph",projectId:"",revision:1,nodes:[
    {id:"approval",kind:"approval",label:"Human approval",inputs:[{id:"media",type:"media",required:true}],outputs:[{id:"media",type:"media"}],config:{media:"asset-placeholder"}}
  ],edges:[]};
  const created=await request("/api/workflows",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Approval workflow",graph})},cookie);
  assert.equal(created.status,201);
  const workflow=(await created.json()).workflow;
  const queued=await request("/api/workflows/"+workflow.id+"/run",{method:"POST"},cookie);
  assert.equal(queued.status,202);
  const runId=(await queued.json()).runId;
  const db=openDatabase(join(dataDir,"executive-visuals.sqlite"));
  try{
    db.prepare("UPDATE workflow_runs SET status='awaiting_approval' WHERE id=?").run(runId);
    db.prepare("UPDATE workflow_node_runs SET status='awaiting_approval',input_json=? WHERE run_id=? AND node_id='approval'").run(json({media:"asset-placeholder"}),runId);
  }finally{db.close();}
  const approved=await request("/api/workflow-runs/"+runId+"/approve",{method:"POST"},cookie);
  assert.equal(approved.status,202);
  const detail=await request("/api/workflow-runs/"+runId,{},cookie);
  const body=await detail.json();
  assert.equal(body.run.status,"queued");
  assert.equal(body.nodes[0].status,"completed");
  assert.equal(body.nodes[0].output.approved,true);
});

test("timelines persist with asset ownership, revision checks and interchange exports",async()=>{
  const cookie=await register("timeline-owner@example.test");
  const upload=await request("/api/assets",{method:"POST",headers:{"content-type":"video/mp4","x-file-name":"timeline-source.mp4"},body:Buffer.from([0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,0,1])},cookie);
  assert.equal(upload.status,201);
  const asset=(await upload.json()).asset;
  const document={
    id:"client-timeline",projectId:null,name:"Test sequence",revision:1,
    frameRate:{numerator:24,denominator:1},width:1920,height:1080,pixelAspectRatio:1,
    tracks:[{id:"track-1",name:"Video 1",kind:"video",enabled:true,locked:false,clips:[
      {id:"clip-1",assetId:asset.id,name:"Opening",sourceRange:{start:{value:0,rate:24},duration:{value:240,rate:24}},timelineStart:{value:0,rate:24},duration:{value:240,rate:24},enabled:true}
    ]}],
    markers:[]
  };
  const create=await request("/api/timelines",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Test sequence",timeline:document,otio:{OTIO_SCHEMA:"Timeline.1",name:"Test sequence"}})},cookie);
  assert.equal(create.status,201,await create.clone().text());
  const timeline=(await create.json()).timeline;
  const renderJob=await request("/api/jobs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jobType:"timeline.render",timelineId:timeline.id})},cookie);
  assert.equal(renderJob.status,202,await renderJob.clone().text());
  assert.equal((await renderJob.json()).job.jobType,"timeline.render");
  const get=await request("/api/timelines/"+timeline.id,{},cookie);
  assert.equal(get.status,200);
  assert.equal((await get.json()).timeline.document.tracks[0].clips[0].assetId,asset.id);
  const exportResponse=await request("/api/timelines/"+timeline.id+"/otio",{},cookie);
  assert.equal((await exportResponse.json()).otio.OTIO_SCHEMA,"Timeline.1");
  const update=await request("/api/timelines/"+timeline.id,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:1,name:"Test sequence v2",timeline:document,otio:{OTIO_SCHEMA:"Timeline.1",name:"Test sequence v2"}})},cookie);
  assert.equal(update.status,200);
  assert.equal((await update.json()).revision,2);
  const stale=await request("/api/timelines/"+timeline.id,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:1,timeline:document})},cookie);
  assert.equal(stale.status,409);
  const other=await register("timeline-other@example.test");
  const hidden=await request("/api/timelines/"+timeline.id,{},other);
  assert.equal(hidden.status,404);
  const invalid={...document,tracks:[{...document.tracks[0],clips:[...document.tracks[0].clips,{...document.tracks[0].clips[0],id:"clip-overlap",timelineStart:{value:120,rate:24}}]}]};
  const reject=await request("/api/timelines",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({timeline:invalid})},cookie);
  assert.equal(reject.status,422);
  assert.equal((await reject.json()).error.code,"TIMELINE_INVALID");
  const first={...document.tracks[0].clips[0],transitionToNext:{type:"dip-to-black",fadeFrames:24}};
  const second={...document.tracks[0].clips[0],id:"clip-next",timelineStart:{value:240,rate:24}};
  const transitioned={...document,tracks:[{...document.tracks[0],clips:[first,second]}]};
  const accepted=await request("/api/timelines",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({timeline:transitioned})},cookie);
  assert.equal(accepted.status,201,await accepted.clone().text());
  const invalidTransition={...transitioned,tracks:[{...transitioned.tracks[0],clips:[{...first,transitionToNext:{type:"dip-to-black",fadeFrames:0}},second]}]};
  const rejectedTransition=await request("/api/timelines",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({timeline:invalidTransition})},cookie);
  assert.equal(rejectedTransition.status,422);
  assert.equal((await rejectedTransition.json()).error.code,"TIMELINE_INVALID");
});


test("project membership separates editor, reviewer and viewer permissions",async()=>{
  const owner=await register("team-owner@example.test");
  const created=await request("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Shared production"})},owner);
  const project=(await created.json()).project;
  const editor=await register("team-editor@example.test");
  const viewer=await register("team-viewer@example.test");
  const reviewer=await register("team-reviewer@example.test");
  const addEditor=await request("/api/projects/"+project.id+"/members",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"team-editor@example.test",role:"editor"})},owner);
  assert.equal(addEditor.status,201);
  const addViewer=await request("/api/projects/"+project.id+"/members",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"team-viewer@example.test",role:"viewer"})},owner);
  assert.equal(addViewer.status,201);
  const addReviewer=await request("/api/projects/"+project.id+"/members",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"team-reviewer@example.test",role:"reviewer"})},owner);
  assert.equal(addReviewer.status,201);
  const sharedProjects=await request("/api/projects",{},editor);
  assert.equal((await sharedProjects.json()).projects[0].access_role,"editor");
  const upload=await request("/api/assets",{method:"POST",headers:{"content-type":"image/png","x-file-name":"shared.png","x-project-id":project.id},body:Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3])},editor);
  assert.equal(upload.status,201);
  const asset=(await upload.json()).asset;
  const ownerAssets=await request("/api/assets?projectId="+project.id,{},owner);
  assert.equal((await ownerAssets.json()).assets.length,1);
  const viewerAssets=await request("/api/assets?projectId="+project.id,{},viewer);
  assert.equal((await viewerAssets.json()).assets.length,1);
  const blockedUpload=await request("/api/assets",{method:"POST",headers:{"content-type":"image/png","x-file-name":"blocked.png","x-project-id":project.id},body:Buffer.from([137,80,78,71,13,10,26,10,0])},viewer);
  assert.equal(blockedUpload.status,404);
  const reviewerComment=await request("/api/reviews",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectId:project.id,assetId:asset.id,timecodeSeconds:4.25,decision:"comment",body:"Check the subject framing at this moment."})},reviewer);
  assert.equal(reviewerComment.status,201);
  const comment=(await reviewerComment.json()).review;
  assert.equal(comment.timecodeSeconds,4.25);
  const viewerComment=await request("/api/reviews",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectId:project.id,decision:"comment",body:"Viewer cannot comment."})},viewer);
  assert.equal(viewerComment.status,403);
  const approve=await request("/api/reviews",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectId:project.id,decision:"approve",body:"Approved for the next stage."})},reviewer);
  assert.equal(approve.status,201);
  assert.equal((await approve.json()).review.status,"resolved");
  const reviews=await request("/api/reviews?projectId="+project.id,{},viewer);
  assert.equal((await reviews.json()).reviews.length,2);
  const timeline={
    id:"shared-sequence",projectId:project.id,name:"Shared sequence",revision:1,
    frameRate:{numerator:24,denominator:1},width:1920,height:1080,pixelAspectRatio:1,
    tracks:[{id:"track",name:"Video 1",kind:"video",enabled:true,locked:false,clips:[
      {id:"clip",assetId:asset.id,name:"Shared image",sourceRange:{start:{value:0,rate:24},duration:{value:120,rate:24}},timelineStart:{value:0,rate:24},duration:{value:120,rate:24},enabled:true}
    ]}],markers:[]
  };
  const save=await request("/api/timelines",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectId:project.id,timeline})},owner);
  assert.equal(save.status,201,await save.clone().text());
  const timelineId=(await save.json()).timeline.id;
  const viewerRead=await request("/api/timelines/"+timelineId,{},viewer);
  assert.equal(viewerRead.status,200);
  const viewerEdit=await request("/api/timelines/"+timelineId,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:1,timeline})},viewer);
  assert.equal(viewerEdit.status,403);
  const editorEdit=await request("/api/timelines/"+timelineId,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:1,timeline})},editor);
  assert.equal(editorEdit.status,200);
  assert.equal((await editorEdit.json()).revision,2);
  const afterEditorEdit=await request("/api/timelines/"+timelineId,{},owner);
  assert.equal((await afterEditorEdit.json()).timeline.revision,2,"editor changes must actually persist on an owner-created timeline");

  const sharedGraph={nodes:[{id:"input",kind:"text",label:"Input",inputs:[],outputs:[{id:"out",type:"text"}],config:{}},{id:"output",kind:"llm.prompt",label:"Output",inputs:[{id:"in",type:"text",required:true}],outputs:[{id:"out",type:"text"}],config:{}}],edges:[{id:"edge",sourceNodeId:"input",sourcePortId:"out",targetNodeId:"output",targetPortId:"in"}]};
  const ownerWorkflow=await request("/api/workflows",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectId:project.id,name:"Shared graph",graph:sharedGraph})},owner);
  assert.equal(ownerWorkflow.status,201);
  const workflowId=(await ownerWorkflow.json()).workflow.id;
  const editorWorkflow=await request("/api/workflows/"+workflowId,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:1,name:"Edited by team member",graph:sharedGraph})},editor);
  assert.equal(editorWorkflow.status,200);
  assert.equal((await editorWorkflow.json()).revision,2,"editor changes must persist on an owner-created workflow");
  const editorInvite=await request("/api/projects/"+project.id+"/members",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"owner-a@example.test",role:"viewer"})},editor);
  assert.equal(editorInvite.status,403);
  const remove=await request("/api/projects/"+project.id+"/members/"+JSON.parse(await addEditor.clone().text()).member.id,{method:"DELETE"},owner);
  assert.equal(remove.status,200);
  const revokedAssets=await request("/api/assets?projectId="+project.id,{},editor);
  assert.equal((await revokedAssets.json()).assets.length,0);
  const revokedTimeline=await request("/api/timelines/"+timelineId,{},editor);
  assert.equal(revokedTimeline.status,404);
});

test("workflow approval requires reviewer permissions and cannot be replayed",async()=>{
  const owner=await register("approval-owner@example.test");
  const viewer=await register("approval-viewer@example.test");
  const editor=await register("approval-editor@example.test");
  const projectResponse=await request("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Approval security"})},owner);
  const project=(await projectResponse.json()).project;
  await request("/api/projects/"+project.id+"/members",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"approval-viewer@example.test",role:"viewer"})},owner);
  await request("/api/projects/"+project.id+"/members",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"approval-editor@example.test",role:"editor"})},owner);
  const graph={nodes:[{id:"brief",kind:"text",inputs:[],outputs:[{id:"text",type:"text"}],config:{text:"Review scene"}},{id:"gate",kind:"approval",inputs:[{id:"text",type:"text",required:true}],outputs:[{id:"text",type:"text"}],config:{}}],edges:[{id:"edge",sourceNodeId:"brief",sourcePortId:"text",targetNodeId:"gate",targetPortId:"text"}]};
  const created=await request("/api/workflows",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectId:project.id,name:"Approval security",graph})},owner);
  assert.equal(created.status,201);
  const workflowId=(await created.json()).workflow.id;
  const started=await request("/api/workflows/"+workflowId+"/run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({target:{kind:"all"}})},owner);
  assert.equal(started.status,202,await started.clone().text());
  const runId=(await started.json()).runId;
  const testDb=openDatabase(join(dataDir,"executive-visuals.sqlite"));
  try{testDb.prepare("UPDATE workflow_runs SET status='awaiting_approval' WHERE id=?").run(runId);testDb.prepare("UPDATE workflow_node_runs SET status='awaiting_approval',input_json=? WHERE run_id=? AND node_id='gate'").run(JSON.stringify({text:"Review scene"}),runId);}finally{testDb.close();}
  const denied=await request("/api/workflow-runs/"+runId+"/approve",{method:"POST"},viewer);
  assert.equal(denied.status,403);assert.equal((await denied.json()).error.code,"REVIEWER_REQUIRED");
  const approved=await request("/api/workflow-runs/"+runId+"/approve",{method:"POST"},editor);
  assert.equal(approved.status,202);
  const replay=await request("/api/workflow-runs/"+runId+"/approve",{method:"POST"},editor);
  assert.equal(replay.status,409);
});

test("transformation plans persist through the authenticated API with role, consent, idempotency and execution gates",async()=>{
  const owner=await register("transform-owner@example.test");
  const editor=await register("transform-editor@example.test");
  const viewer=await register("transform-viewer@example.test");
  const stranger=await register("transform-stranger@example.test");
  const projectResponse=await request("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Transformation production"})},owner);
  assert.equal(projectResponse.status,201);
  const project=(await projectResponse.json()).project;
  await request("/api/projects/"+project.id+"/members",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"transform-editor@example.test",role:"editor"})},owner);
  await request("/api/projects/"+project.id+"/members",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"transform-viewer@example.test",role:"viewer"})},owner);
  const video=await request("/api/assets",{method:"POST",headers:{"content-type":"video/mp4","x-file-name":"source.mp4","x-project-id":project.id},body:Buffer.from([0,0,0,24,0x66,0x74,0x79,0x70,0x69,0x73,0x6f,0x6d,0,0,0,1])},owner);
  assert.equal(video.status,201);
  const source=(await video.json()).asset;
  const image=await request("/api/assets",{method:"POST",headers:{"content-type":"image/png","x-file-name":"vehicle-reference.png","x-project-id":project.id},body:Buffer.from([137,80,78,71,13,10,26,10,0,1,2,3])},owner);
  assert.equal(image.status,201);
  const reference=(await image.json()).asset;
  const payload={projectId:project.id,sourceAssetId:source.id,operation:"vehicle_replace",prompt:"Replace the parked vehicle with a graphite electric SUV while preserving camera motion and scene lighting.",durationSeconds:8,referenceAssetIds:[reference.id],preservation:["camera_motion","composition","source_audio"],rightsConfirmed:true,subjectConsentConfirmed:false};
  const unauthenticated=await request("/api/transformations",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
  assert.equal(unauthenticated.status,401);
  const first=await request("/api/transformations",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"transform-api-key-001"},body:JSON.stringify(payload)},owner);
  assert.equal(first.status,201,await first.clone().text());
  const created=(await first.json()).plan;
  assert.equal(created.status,"draft");
  assert.equal(created.projectId,project.id);
  assert.equal(created.sourceAssetId,source.id);
  assert.deepEqual(created.referenceAssetIds,[reference.id]);
  const replay=await request("/api/transformations",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"transform-api-key-001"},body:JSON.stringify(payload)},owner);
  assert.equal(replay.status,200);
  assert.equal((await replay.json()).idempotentReplay,true);
  const auditDb=openDatabase(join(dataDir,"executive-visuals.sqlite"));
  try{assert.equal(auditDb.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type='transformation.draft_created' AND subject_id=?").get(created.id).count,1,"idempotent draft replay must not emit a duplicate creation audit event");}finally{auditDb.close();}
  const conflict=await request("/api/transformations",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"transform-api-key-001"},body:JSON.stringify({...payload,prompt:"Change the vehicle to a red classic sports car instead."})},owner);
  assert.equal(conflict.status,409);
  assert.equal((await conflict.json()).error.code,"IDEMPOTENCY_CONFLICT");
  const viewerList=await request("/api/transformations?projectId="+project.id,{},viewer);
  assert.equal(viewerList.status,200);
  assert.equal((await viewerList.json()).plans.length,1);
  const viewerCreate=await request("/api/transformations",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"transform-viewer-key"},body:JSON.stringify({...payload,prompt:"A valid edit request from a viewer."})},viewer);
  assert.equal(viewerCreate.status,404);
  const personWithoutConsent=await request("/api/transformations",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"transform-person-key"},body:JSON.stringify({...payload,operation:"person_replace"})},owner);
  assert.equal(personWithoutConsent.status,403);
  assert.equal((await personWithoutConsent.json()).error.code,"SUBJECT_CONSENT_REQUIRED");
  const wrongProject=await request("/api/transformations/"+created.id,{},stranger);
  assert.equal(wrongProject.status,404);
  const viewerApprove=await request("/api/transformations/"+created.id+"/approve",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({estimatedCostMicros:250,approvedBudgetMicros:250,currency:"USD",adapterId:"unconfigured",capability:"video.transform"})},viewer);
  assert.equal(viewerApprove.status,404);
  const underfunded=await request("/api/transformations/"+created.id+"/approve",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({estimatedCostMicros:251,approvedBudgetMicros:250,currency:"USD",adapterId:"unconfigured",capability:"video.transform"})},editor);
  assert.equal(underfunded.status,400);
  assert.equal((await underfunded.json()).error.code,"TRANSFORMATION_BUDGET_INVALID");
  const approved=await request("/api/transformations/"+created.id+"/approve",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({estimatedCostMicros:250,approvedBudgetMicros:300,currency:"USD",adapterId:"unconfigured",capability:"video.transform"})},editor);
  assert.equal(approved.status,200);
  assert.equal((await approved.json()).plan.status,"approved");
  const approvalReplay=await request("/api/transformations/"+created.id+"/approve",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({estimatedCostMicros:250,approvedBudgetMicros:300,currency:"USD",adapterId:"unconfigured",capability:"video.transform"})},editor);
  assert.equal(approvalReplay.status,409);
  assert.equal((await approvalReplay.json()).error.code,"TRANSFORMATION_STATE_CONFLICT");
  const submit=await request("/api/transformations/"+created.id+"/submit",{method:"POST"},editor);
  assert.equal(submit.status,409);
  assert.equal((await submit.json()).error.code,"TRANSFORMATION_ADAPTER_UNAVAILABLE");
  const detail=await request("/api/transformations/"+created.id,{},owner);
  assert.equal((await detail.json()).plan.status,"approved","failed closed submission must preserve the approved plan without claiming a queued job");
  const db=openDatabase(join(dataDir,"executive-visuals.sqlite"));
  try{assert.equal(db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE job_type LIKE 'video.transform%'").get().count,0);}finally{db.close();}
});

test.after(async()=>{
  child.kill("SIGTERM");
  await new Promise(resolve=>d1ProxyServer.close(resolve));
  await new Promise(resolve=>{const timer=setTimeout(resolve,1500);child.once("exit",()=>{clearTimeout(timer);resolve();});});
  await rm(dataDir,{recursive:true,force:true});
});


test("project evidence ledger is asset-bound, reviewer-gated, append-only and exposes immutable graph baselines",async()=>{
  const owner=await register("evidence-owner@example.test");
  const reviewer=await register("evidence-reviewer@example.test");
  const viewer=await register("evidence-viewer@example.test");
  const projectResponse=await request("/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Evidence review project"})},owner);
  assert.equal(projectResponse.status,201);
  const project=(await projectResponse.json()).project;

  const upload=await request("/api/assets",{method:"POST",headers:{"content-type":"image/png","x-file-name":encodeURIComponent("source.png"),"x-project-id":project.id},body:Buffer.from([137,80,78,71,13,10,26,10])},owner);
  await expectStatus(upload,201);
  const asset=(await upload.json()).asset;

  const workspace=await request("/api/projects/"+project.id+"/workspace",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({revision:0,document:{shots:[{id:"shot-1",scene:"Opening",action:"Presenter demonstrates the approved workflow"}],characters:[{id:"character-1",name:"Maya",description:"Presenter"}]}})},owner);
  assert.equal(workspace.status,200,await workspace.text());

  const submission=await request("/api/assets/"+asset.id+"/evidence",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({targetType:"project",targetId:project.id,kind:"source_reference",claim:"The uploaded source supports the approved project reference.",method:"Human review of the original file",sourceRef:"capture://source-01",observedAt:"2026-11-13T10:00:00.000Z"})},owner);
  await expectStatus(submission,201);
  const submitted=await submission.json();
  assert.equal(submitted.record.status,"submitted");
  assert.equal(submitted.events.length,1);
  assert.equal(submitted.events[0].type,"submitted");

  const shotEvidence=await request("/api/assets/"+asset.id+"/evidence",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({targetType:"shot",targetId:"shot-1",kind:"shot_reference",claim:"This source shows the presenter action planned for shot one."})},owner);
  await expectStatus(shotEvidence,201);
  assert.equal((await shotEvidence.json()).record.target.id,"shot-1");

  const forged=await request("/api/assets/"+asset.id+"/evidence",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({status:"verified",targetType:"project",targetId:project.id,kind:"source_reference",claim:"This should never be accepted as pre-verified."})},owner);
  assert.equal(forged.status,400);

  const addReviewer=await request("/api/projects/"+project.id+"/members",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"evidence-reviewer@example.test",role:"reviewer"})},owner);
  assert.equal(addReviewer.status,201,await addReviewer.text());
  const addViewer=await request("/api/projects/"+project.id+"/members",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"evidence-viewer@example.test",role:"viewer"})},owner);
  assert.equal(addViewer.status,201,await addViewer.text());
  const viewerAttempt=await request("/api/assets/"+asset.id+"/evidence/"+submitted.record.id+"/review",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({status:"verified",reviewNote:"Viewer must not be allowed to review."})},viewer);
  assert.equal(viewerAttempt.status,403);

  const shortReason=await request("/api/assets/"+asset.id+"/evidence/"+submitted.record.id+"/review",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({status:"verified",reviewNote:"ok"})},reviewer);
  assert.equal(shortReason.status,400);

  const reviewed=await request("/api/assets/"+asset.id+"/evidence/"+submitted.record.id+"/review",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({status:"verified",reviewNote:"Original source inspected; project claim scope accepted."})},reviewer);
  await expectStatus(reviewed,200);
  const reviewedBody=await reviewed.json();
  assert.equal(reviewedBody.record.status,"verified");
  assert.equal(reviewedBody.record.reviewedBy!==null,true);
  assert.deepEqual(reviewedBody.events.map(event=>event.type),["submitted","reviewed"]);

  const replay=await request("/api/assets/"+asset.id+"/evidence/"+submitted.record.id+"/review",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({status:"rejected",reviewNote:"Second decision should conflict."})},owner);
  assert.equal(replay.status,409);

  const listed=await request("/api/evidence?projectId="+encodeURIComponent(project.id),{},owner);
  assert.equal(listed.status,200);
  assert.ok((await listed.json()).records.some(record=>record.id===submitted.record.id));

  const graph={nodes:[{id:"project:"+project.id,type:"project",label:"Evidence review project",status:"linked"},{id:"shot:shot-1",type:"shot",label:"Shot 1",status:"review"}],edges:[{from:"project:"+project.id,to:"shot:shot-1",relation:"contains",evidence:"project_scope"}]};
  const snapshot=await request("/api/projects/"+project.id+"/creative-graph/snapshots",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({graph})},owner);
  await expectStatus(snapshot,201);
  const saved=(await snapshot.json()).snapshot;
  assert.equal(saved.revision,1);
  const loaded=await request("/api/projects/"+project.id+"/creative-graph/snapshots",{},reviewer);
  assert.equal(loaded.status,200);
  assert.equal((await loaded.json()).snapshot.graphHash,saved.graphHash);
});
