import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync=promisify(execFile);

test("Supabase auth missing encryption secret keeps the application online but fails protected routes closed",async()=>{
 const root=await mkdtemp(join(tmpdir(),"executive-visuals-auth-config-"));
 const moduleUrl=new URL("../index.mjs",import.meta.url).href;
 const script=`
  const {createAppServer}=await import(${JSON.stringify(moduleUrl)});
  const server=createAppServer();
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  try{
   const port=server.address().port,base="http://127.0.0.1:"+port;
   const health=await fetch(base+"/api/health");
   const healthBody=await health.json();
   const protectedResponse=await fetch(base+"/api/me");
   const protectedBody=await protectedResponse.json();
   process.stdout.write(JSON.stringify({healthStatus:health.status,authMode:healthBody.authMode,configurationReady:healthBody.authSession?.configurationReady,encryptedServerTokens:healthBody.authSession?.encryptedServerTokens,protectedStatus:protectedResponse.status,protectedCode:protectedBody.error?.code})+"\\n");
  }finally{await new Promise(resolve=>server.close(resolve));}
  process.exit(0);
 `;
 try{
  const env={...process.env,NODE_ENV:"test",AUTH_MODE:"supabase",DATA_DIR:join(root,"data"),DB_FILE:join(root,"data","auth.sqlite"),MEDIA_ROOT:join(root,"media"),WEB_ROOT:join(root,"dist"),SUPABASE_URL:"https://example.supabase.co",SUPABASE_PUBLISHABLE_KEY:"sb_publishable_test"};
  delete env.SUPABASE_SESSION_ENCRYPTION_KEY;
  const {stdout,stderr}=await execFileAsync(process.execPath,["--input-type=module","-e",script],{cwd:process.cwd(),env,timeout:15000,maxBuffer:1024*1024});
  const result=JSON.parse(stdout.trim());
  assert.equal(result.healthStatus,200,stderr);
  assert.equal(result.authMode,"supabase");
  assert.equal(result.configurationReady,false);
  assert.equal(result.encryptedServerTokens,false);
  assert.equal(healthBody.cloudMedia?.enabled,false);
  assert.equal(healthBody.cloudMedia?.ready,false);
  assert.equal(result.protectedStatus,503);
  assert.equal(result.protectedCode,"SUPABASE_SESSION_ENCRYPTION_NOT_CONFIGURED");
 }finally{await rm(root,{recursive:true,force:true});}
});
