import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";

const user={id:"user-1",email:"studio@example.test"};
let refreshCalls=0;
const authCalls=[];
function send(res,status,payload=null){
 res.writeHead(status,payload===null?{}:{"content-type":"application/json"});
 res.end(payload===null?"":JSON.stringify(payload));
}
async function bodyOf(req){
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 const raw=Buffer.concat(chunks).toString("utf8");return raw?JSON.parse(raw):{};
}
const authServer=createServer((req,res)=>{
 void (async()=>{
  const url=new URL(req.url||"/","http://127.0.0.1");
  const body=await bodyOf(req);
  authCalls.push({path:url.pathname+url.search,method:req.method,authorization:req.headers.authorization||"",body});
  if(url.pathname==="/auth/v1/signup"&&req.method==="POST"){
   send(res,200,{user});return;
  }
  if(url.pathname==="/auth/v1/token"&&url.searchParams.get("grant_type")==="password"){
   send(res,200,{access_token:"expired-access",refresh_token:"single-use-refresh",expires_in:3600,user});return;
  }
  if(url.pathname==="/auth/v1/token"&&url.searchParams.get("grant_type")==="refresh_token"){
   refreshCalls++;
   await new Promise(resolve=>setTimeout(resolve,35));
   if(body.refresh_token!=="single-use-refresh"){send(res,400,{msg:"refresh token already used"});return;}
   send(res,200,{access_token:"fresh-access",refresh_token:"fresh-refresh",expires_in:3600,user});return;
  }
  if(url.pathname==="/auth/v1/user"&&req.method==="GET"){
   const token=String(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
   if(token==="expired-access"){send(res,401,{msg:"expired"});return;}
   if(token==="fresh-access"||token.startsWith("recovery.")){send(res,200,user);return;}
   send(res,401,{msg:"invalid token"});return;
  }
  if(url.pathname==="/auth/v1/user"&&req.method==="PUT"){send(res,200,user);return;}
  if(url.pathname==="/auth/v1/logout"){send(res,200,{});return;}
  if(url.pathname==="/auth/v1/recover"){send(res,200,{});return;}
  send(res,404,{msg:"mock auth route not found"});
  })().catch(error=>send(res,500,{msg:String(error.message||error)}));
});
function listen(server){
 return new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>{server.removeListener("error",reject);resolve(server.address().port);});});
}
function close(server){
 return new Promise(resolve=>{if(!server.listening)return resolve();server.close(()=>resolve());});
}
function call(port,path,{method="GET",headers={},body=null}={}){
 return new Promise((resolve,reject)=>{
  const data=body===null?null:Buffer.from(typeof body==="string"?body:JSON.stringify(body));
  const request=httpRequest({hostname:"127.0.0.1",port,path,method,headers:{...(data?{"content-type":"application/json","content-length":String(data.length)}:{}),...headers}},response=>{
   const chunks=[];response.on("data",chunk=>chunks.push(chunk));response.on("end",()=>{
    const raw=Buffer.concat(chunks).toString("utf8");let parsed=null;try{parsed=raw?JSON.parse(raw):null;}catch{}
    resolve({status:response.statusCode,headers:response.headers,body:parsed,raw});
   });
  });
  request.on("error",reject);if(data)request.write(data);request.end();
 });
}
function recoveryToken(){
 const payload={sub:user.id,iss:process.env.SUPABASE_URL+"/auth/v1",aud:"authenticated",role:"authenticated",exp:Math.floor(Date.now()/1000)+3600,amr:[{method:"recovery"}]};
 return "recovery."+Buffer.from(JSON.stringify(payload)).toString("base64url")+".signature";
}

test("Supabase browser auth routes use opaque cookies, serialize refresh, recover and revoke",async()=>{
 const root=await mkdtemp(join(tmpdir(),"executive-visuals-auth-http-"));
 let appServer=null,appOrigin="";
 try{
  const dataDir=join(root,"data");await mkdir(dataDir,{recursive:true});
  process.env.NODE_ENV="test";
  process.env.AUTH_MODE="supabase";
  process.env.DATA_DIR=dataDir;
  process.env.DB_FILE=join(dataDir,"auth.sqlite");
  process.env.MEDIA_ROOT=join(dataDir,"media");
  process.env.WEB_ROOT=join(root,"dist");
  process.env.COOKIE_SECURE="true";
  process.env.SUPABASE_PUBLISHABLE_KEY="sb_publishable_test";
  process.env.SUPABASE_SESSION_ENCRYPTION_KEY=Buffer.alloc(32,31).toString("hex");
  const authPort=await listen(authServer);
  process.env.SUPABASE_URL="http://127.0.0.1:"+authPort;
  const {createAppServer}=await import("../index.mjs");
  appServer=createAppServer();
  const appPort=await listen(appServer);
  appOrigin="http://127.0.0.1:"+appPort;
  process.env.PUBLIC_APP_URL=appOrigin+"/";
  process.env.CORS_ORIGINS=appOrigin;

  const origin={"origin":appOrigin,"sec-fetch-site":"same-origin"};
  const csrf=await call(appPort,"/api/auth/login",{method:"POST",body:{email:user.email,password:"long-password-123"},headers:{"content-type":"application/json"}});
  assert.equal(csrf.status,403,"state-changing auth routes reject requests without an exact Origin");

  const signup=await call(appPort,"/api/auth/register",{method:"POST",headers:origin,body:{email:user.email,password:"long-password-123"}});
  assert.equal(signup.status,202,"sign-up returns the email-confirmation state when Supabase has not issued a session");
  assert.equal(signup.body.confirmationRequired,true);
  assert.equal(signup.headers["set-cookie"],undefined);

  const login=await call(appPort,"/api/auth/login",{method:"POST",headers:origin,body:{email:user.email,password:"long-password-123"}});
  assert.equal(login.status,200);
  const cookies=login.headers["set-cookie"];
  assert.equal(Array.isArray(cookies),true);
  assert.equal(cookies.length,3,"one opaque session cookie is issued and legacy token cookies are expired");
  assert.match(cookies[0],/^ev_supabase_session=/);
  assert.match(cookies[0],/HttpOnly/);assert.match(cookies[0],/Secure/);assert.match(cookies[0],/SameSite=Strict/);
  assert.equal(cookies.some(value=>value.includes("expired-access")||value.includes("single-use-refresh")),false);
  const browserCookie=cookies[0].split(";")[0];

  const [first,second]=await Promise.all([
   call(appPort,"/api/me",{headers:{cookie:browserCookie}}),
   call(appPort,"/api/me",{headers:{cookie:browserCookie}})
  ]);
  assert.equal(first.status,200);assert.equal(second.status,200);
  assert.equal(first.body.user.id,user.id);assert.equal(second.body.user.id,user.id);
  assert.equal(refreshCalls,1,"parallel API requests rotate the single-use refresh token only once");

  const recovery=await call(appPort,"/api/auth/recover",{method:"POST",headers:origin,body:{email:user.email}});
  assert.equal(recovery.status,200);
  const reset=await call(appPort,"/api/auth/password",{method:"PUT",headers:{...origin,authorization:"Bearer "+recoveryToken()},body:{password:"new-long-password-456"}});
  assert.equal(reset.status,200);assert.equal(reset.body.ok,true);

  const logout=await call(appPort,"/api/auth/logout",{method:"POST",headers:{...origin,cookie:browserCookie}});
  assert.equal(logout.status,200);
  assert.equal(authCalls.some(x=>x.path==="/auth/v1/logout"&&x.authorization==="Bearer fresh-access"),true);
  assert.equal(logout.headers["set-cookie"].length,3);
  assert.equal(logout.headers["set-cookie"].every(value=>/Max-Age=0/.test(value)),true);
  const afterLogout=await call(appPort,"/api/me");
  assert.equal(afterLogout.status,401);

  const legacy=await call(appPort,"/api/me",{headers:{cookie:"ev_supabase_access=legacy-access; ev_supabase_refresh=legacy-refresh"}});
  assert.equal(legacy.status,401);
  assert.equal(legacy.headers["set-cookie"].length,3,"legacy raw-token cookies are cleared when encountered without an opaque session");
  assert.equal(legacy.headers["set-cookie"].every(value=>/Max-Age=0/.test(value)),true);
 }finally{
  await close(appServer);
  await close(authServer);
  await rm(root,{recursive:true,force:true});
 }
});
