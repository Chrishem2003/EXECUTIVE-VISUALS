import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {spawn} from "node:child_process";
import {mkdtemp,mkdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
const listen=server=>new Promise(resolve=>server.listen(0,"127.0.0.1",()=>resolve(server.address().port)));
const providerCalls=[];
const provider=createServer(async(req,res)=>{
 let raw="";for await(const chunk of req)raw+=chunk;
 providerCalls.push({url:req.url,authorization:req.headers.authorization,body:raw?JSON.parse(raw):null});
 res.setHeader("content-type","application/json");
 if(req.url.startsWith("/auth/v1/token?grant_type=password")){res.end(JSON.stringify({access_token:"provider-access-token-123456789",refresh_token:"provider-refresh-token-123456789",expires_in:3600,user:{id:"supabase-user-1",email:"owner@example.test",email_confirmed_at:"2026-11-01T00:00:00Z"}}));return;}
 if(req.url.startsWith("/auth/v1/token?grant_type=refresh_token")){res.end(JSON.stringify({access_token:"provider-access-token-refreshed",refresh_token:"provider-refresh-token-refreshed",expires_in:3600,user:{id:"supabase-user-1",email:"owner@example.test",email_confirmed_at:"2026-11-01T00:00:00Z"}}));return;}
 if(req.url.startsWith("/auth/v1/signup")){res.end(JSON.stringify({user:{id:"supabase-user-2",email:"new@example.test"}}));return;}
 if(req.url.startsWith("/auth/v1/recover")){res.end(JSON.stringify({message:"accepted"}));return;}
 if(req.url==="/auth/v1/logout"){res.end(JSON.stringify({}));return;}
 if(req.url==="/auth/v1/user"&&req.method==="PUT"){res.end(JSON.stringify({id:"supabase-user-1",email:"owner@example.test",email_confirmed_at:"2026-11-01T00:00:00Z"}));return;}
 if(req.url==="/auth/v1/user"){res.end(JSON.stringify({id:"supabase-user-1",email:"owner@example.test",email_confirmed_at:"2026-11-01T00:00:00Z"}));return;}
 res.statusCode=404;res.end(JSON.stringify({message:"not found"}));
});
const providerPort=await listen(provider);
const portServer=createServer();const apiPort=await listen(portServer);await new Promise(resolve=>portServer.close(resolve));
const dataDir=await mkdtemp(join(tmpdir(),"ev-supabase-auth-api-"));const webDir=join(dataDir,"web");await mkdir(webDir,{recursive:true});await writeFile(join(webDir,"index.html"),"<!doctype html><html><body>test</body></html>");
const child=spawn(process.execPath,["server/index.mjs"],{cwd:process.cwd(),env:{...process.env,NODE_ENV:"development",AUTH_MODE:"supabase",SUPABASE_URL:"http://127.0.0.1:"+providerPort,SUPABASE_PUBLISHABLE_KEY:"sb_publishable_test",SUPABASE_AUTH_REDIRECT_URL:"https://studio.example.test/auth/callback",API_HOST:"127.0.0.1",API_PORT:String(apiPort),DATA_DIR:dataDir,MEDIA_ROOT:join(dataDir,"media"),WEB_ROOT:webDir,DISABLE_WORKER:"true"},stdio:["ignore","pipe","pipe"]});
let stderr="";child.stderr.on("data",chunk=>stderr+=chunk.toString());
const base="http://127.0.0.1:"+apiPort;
async function wait(){for(let i=0;i<80;i++){if(child.exitCode!==null)throw new Error("API exited: "+stderr);try{if((await fetch(base+"/api/health")).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw new Error("API did not start: "+stderr);}
await wait();
async function post(path,body,cookie,accessToken){return fetch(base+path,{method:"POST",headers:{"content-type":"application/json",...(cookie?{cookie}:{}),...(accessToken?{authorization:"Bearer "+accessToken}:{})},body:JSON.stringify(body||{})});}
test("Supabase mode supports password sign-in, HttpOnly refresh cookie, session rotation, recovery and logout",async t=>{
 t.after(async()=>{child.kill("SIGTERM");provider.close();await rm(dataDir,{recursive:true,force:true});});
 const login=await post("/api/auth/login",{email:"owner@example.test",password:"correct-horse-battery"});assert.equal(login.status,200);
 const loginBody=await login.json();assert.equal(loginBody.user.id,"supabase-user-1");assert.equal(loginBody.user.emailVerified,true);assert.equal(loginBody.accessToken,"provider-access-token-123456789");
 const cookie=login.headers.get("set-cookie");assert.match(cookie,/ev_supabase_refresh=/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(cookie,/Path=\/api\/auth/);
 const me=await fetch(base+"/api/me",{headers:{authorization:"Bearer "+loginBody.accessToken}});assert.equal(me.status,200);const meBody=await me.json();assert.equal(meBody.user.email,"owner@example.test");assert.equal(meBody.user.emailVerified,true);
 const cookiePair=cookie.split(";")[0];
 const refresh=await post("/api/auth/session",{},cookiePair);assert.equal(refresh.status,200);const refreshed=await refresh.json();assert.equal(refreshed.accessToken,"provider-access-token-refreshed");
 assert.match(refresh.headers.get("set-cookie"),/provider-refresh-token-refreshed/);
 const passwordUpdate=await post("/api/auth/password",{password:"a-new-long-password"},null,loginBody.accessToken);assert.equal(passwordUpdate.status,200);assert.equal((await passwordUpdate.json()).ok,true);
 const signup=await post("/api/auth/register",{email:"new@example.test",password:"a-long-enough-password"});assert.equal(signup.status,202);assert.equal((await signup.json()).confirmationRequired,true);
 const recovery=await post("/api/auth/recover",{email:"owner@example.test"});assert.equal(recovery.status,202);
 const recoverySecond=await post("/api/auth/recover",{email:"owner@example.test"});assert.equal(recoverySecond.status,202);
 const recoveryThird=await post("/api/auth/recover",{email:"owner@example.test"});assert.equal(recoveryThird.status,202);
 const recoveryLimited=await post("/api/auth/recover",{email:"owner@example.test"});assert.equal(recoveryLimited.status,429);assert.equal((await recoveryLimited.json()).error.code,"AUTH_EMAIL_RATE_LIMITED");
 const logout=await post("/api/auth/logout",{},refresh.headers.get("set-cookie").split(";")[0]);assert.equal(logout.status,200);assert.match(logout.headers.get("set-cookie"),/Max-Age=0/);
 assert.ok(providerCalls.some(call=>call.url.startsWith("/auth/v1/token?grant_type=password")));
 assert.ok(providerCalls.some(call=>call.url.startsWith("/auth/v1/token?grant_type=refresh_token")));
 assert.ok(providerCalls.some(call=>call.url.startsWith("/auth/v1/recover")));
 assert.ok(providerCalls.some(call=>call.url==="/auth/v1/logout"));
});
