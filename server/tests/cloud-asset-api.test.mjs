import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {spawn} from "node:child_process";
import {mkdtemp,mkdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
const ownerId="123e4567-e89b-42d3-a456-426614174000";
const assetId="323e4567-e89b-42d3-a456-426614174000";
const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3,4]);
const providerCalls=[];let assetRow=null;
const provider=createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks);
 providerCalls.push({url:req.url,method:req.method,authorization:req.headers.authorization,body:raw});
 res.setHeader("content-type","application/json");
 if(req.url.startsWith("/auth/v1/token?grant_type=password")){res.end(JSON.stringify({access_token:"cloud-api-access-token-123456789",refresh_token:"cloud-api-refresh-token-123456789",expires_in:3600,user:{id:ownerId,email:"owner@example.test"}}));return;}
 if(req.url==="/auth/v1/user"){res.end(JSON.stringify({id:ownerId,email:"owner@example.test"}));return;}
 if(req.url.startsWith("/storage/v1/object/sign/")){res.end(JSON.stringify({signedURL:"/object/sign/executive-visuals-media/"+ownerId+"/"+(assetRow?.id||assetId)+"/original.png?token=short-lived"}));return;}
 if(req.url==="/storage/v1/object/executive-visuals-media"&&req.method==="DELETE"){res.end(JSON.stringify({}));return;}
 if(req.url.startsWith("/storage/v1/object/executive-visuals-media/")&&req.method==="POST"){res.end(JSON.stringify({Key:req.url}));return;}
 if(req.url.startsWith("/rest/v1/assets")&&req.method==="POST"){
  const payload=JSON.parse(raw.toString("utf8"));assetRow={...payload,created_at:"2026-11-03T00:00:00.000Z",deleted_at:null};
  res.end(JSON.stringify([assetRow]));return;
 }
 if(req.url.startsWith("/rest/v1/assets")&&req.method==="PATCH"){
  assetRow={...assetRow,deleted_at:"2026-11-03T00:01:00.000Z"};res.end(JSON.stringify([assetRow]));return;
 }
 if(req.url.startsWith("/rest/v1/assets")){const query=new URL(req.url,"http://provider").searchParams;const derivative=query.get("derivative_of")?.replace(/^eq\./,"");const id=query.get("id")?.replace(/^eq\./,"");const match=assetRow&&!assetRow.deleted_at&&(!derivative||assetRow.derivative_of===derivative)&&(!id||assetRow.id===id);res.end(JSON.stringify(match?[assetRow]:[]));return;}
 res.statusCode=404;res.end(JSON.stringify({message:"not found"}));
});
const listen=server=>new Promise(resolve=>server.listen(0,"127.0.0.1",()=>resolve(server.address().port)));
const providerPort=await listen(provider);const portServer=createServer();const apiPort=await listen(portServer);await new Promise(resolve=>portServer.close(resolve));
const dataDir=await mkdtemp(join(tmpdir(),"ev-cloud-asset-api-")),webDir=join(dataDir,"web");await mkdir(webDir,{recursive:true});await writeFile(join(webDir,"index.html"),"<!doctype html><html><body>test</body></html>");
const child=spawn(process.execPath,["server/index.mjs"],{cwd:process.cwd(),env:{...process.env,NODE_ENV:"development",AUTH_MODE:"supabase",SUPABASE_URL:"http://127.0.0.1:"+providerPort,SUPABASE_PUBLISHABLE_KEY:"sb_publishable_test",SUPABASE_SERVICE_ROLE_KEY:"server-only-test-key",SUPABASE_AUTH_REDIRECT_URL:"https://studio.example.test/",CLOUD_ASSETS_ENABLED:"true",CLOUD_MEDIA_MAX_UPLOAD_BYTES:"1048576",API_HOST:"127.0.0.1",API_PORT:String(apiPort),DATA_DIR:dataDir,MEDIA_ROOT:join(dataDir,"media"),WEB_ROOT:webDir,DISABLE_WORKER:"true"},stdio:["ignore","pipe","pipe"]});
let stderr="";child.stderr.on("data",chunk=>stderr+=chunk.toString());const base="http://127.0.0.1:"+apiPort;
async function wait(){for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error("API exited: "+stderr);try{if((await fetch(base+"/api/health")).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error("API did not start: "+stderr);}
await wait();
test("private cloud asset API streams upload, lists metadata, issues short-lived links and soft-deletes",async t=>{
 t.after(async()=>{child.kill("SIGTERM");provider.close();await rm(dataDir,{recursive:true,force:true});});
 const health=await (await fetch(base+"/api/health")).json();assert.deepEqual(health.cloudAssets,{enabled:true,configured:true});
 const denied=await fetch(base+"/api/cloud/assets");assert.equal(denied.status,401);
 const login=await fetch(base+"/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"owner@example.test",password:"correct-horse-battery"})});assert.equal(login.status,200);
 const {accessToken}=await login.json();const auth={authorization:"Bearer "+accessToken};
 const upload=await fetch(base+"/api/cloud/assets",{method:"POST",headers:{...auth,"content-type":"image/png","x-file-name":"cover.png"},body:png});assert.equal(upload.status,201);
 const uploaded=await upload.json();assert.equal(uploaded.asset.ownerId,ownerId);assert.equal(uploaded.asset.name,"cover.png");assert.equal(uploaded.asset.size,png.length);assert.equal(uploaded.asset.storageBucket,"executive-visuals-media");
 assert.ok(!JSON.stringify(uploaded).includes("server-only-test-key"));
 const assetId=uploaded.asset.id;
 const list=await fetch(base+"/api/cloud/assets",{headers:auth});assert.equal(list.status,200);assert.equal((await list.json()).assets.length,1);
 const lineage=await fetch(base+"/api/cloud/assets/"+assetId+"/lineage",{headers:auth});assert.equal(lineage.status,200);const lineageBody=await lineage.json();assert.deepEqual(lineageBody.lineage.ancestors.map(item=>item.id),[assetId]);assert.deepEqual(lineageBody.lineage.derivatives,[]);
 const signed=await fetch(base+"/api/cloud/assets/"+assetId+"/url",{headers:auth});assert.equal(signed.status,200);assert.match((await signed.json()).url,/token=short-lived/);
 const file=await fetch(base+"/api/cloud/assets/"+assetId+"/file",{headers:auth,redirect:"manual"});assert.equal(file.status,302);assert.match(file.headers.get("location")||"",/token=short-lived/);assert.equal(file.headers.get("cache-control"),"private, no-store");
 const deleted=await fetch(base+"/api/cloud/assets/"+assetId,{method:"DELETE",headers:auth});assert.equal(deleted.status,200);assert.equal((await deleted.json()).storageRemoved,true);
 assert.ok(providerCalls.some(call=>call.url.startsWith("/storage/v1/object/executive-visuals-media/")&&call.method==="POST"));
 assert.ok(providerCalls.some(call=>call.url.startsWith("/storage/v1/object/sign/")));
 assert.ok(providerCalls.some(call=>call.url==="/storage/v1/object/executive-visuals-media"&&call.method==="DELETE"));
});
