import test from "node:test";
import assert from "node:assert/strict";
import {signInWithSupabasePassword,signUpWithSupabasePassword,refreshSupabaseSession,getSupabaseUser,requestSupabasePasswordRecovery,updateSupabasePassword,isSupabaseRecoveryToken} from "../supabase-password-auth.mjs";
const config={supabaseUrl:"https://example.supabase.co",publishableKey:"sb_publishable_test"};
function mockFetch(payload,status=200){return async (url,options)=>({ok:status>=200&&status<300,status,text:async()=>JSON.stringify(payload),url:String(url),options});}
const session={access_token:"access-token",refresh_token:"refresh-token",expires_in:3600,user:{id:"user-1",email:"test@example.com"}};
test("signs in with a password and returns only the validated session fields",async()=>{
 const result=await signInWithSupabasePassword({...config,email:"Test@example.com",password:"secret",fetchImpl:mockFetch(session)});
 assert.equal(result.user.id,"user-1");assert.equal(result.accessToken,"access-token");assert.equal(result.refreshToken,"refresh-token");
});
test("rejects malformed local input before contacting the identity provider",async()=>{
 await assert.rejects(()=>signInWithSupabasePassword({...config,email:"bad",password:"x"}),e=>e.code==="INVALID_CREDENTIALS");
 await assert.rejects(()=>signUpWithSupabasePassword({...config,email:"test@example.com",password:"short"}),e=>e.code==="INVALID_CREDENTIALS");
});
test("maps rejected credentials to a safe 401 response",async()=>{
 await assert.rejects(()=>signInWithSupabasePassword({...config,email:"test@example.com",password:"secret",fetchImpl:mockFetch({msg:"bad password"},400)}),e=>e.status===401&&e.code==="INVALID_CREDENTIALS");
});
test("returns confirmation-required state when Supabase does not issue a session",async()=>{
 const result=await signUpWithSupabasePassword({...config,email:"test@example.com",password:"long-password-123",fetchImpl:mockFetch({user:{id:"user-1",email:"test@example.com"}})});
 assert.equal(result.confirmationRequired,true);
});
test("refreshes a session and validates user identity",async()=>{
 const refreshed=await refreshSupabaseSession({...config,refreshToken:"old-refresh",fetchImpl:mockFetch(session)});
 assert.equal(refreshed.accessToken,"access-token");
 const user=await getSupabaseUser({...config,accessToken:"access-token",fetchImpl:mockFetch({id:"user-1",email:"test@example.com"})});
 assert.equal(user.id,"user-1");
});

test("requests recovery with normalized email and fixed HTTPS redirect",async()=>{let requested;const result=await requestSupabasePasswordRecovery({...config,email:"Test@example.com",redirectTo:"https://app.example.com/",fetchImpl:async(url,options)=>{requested={url:String(url),options};return{ok:true,status:200,text:async()=>""};}});assert.equal(result.ok,true);assert.equal(requested.url,"https://example.supabase.co/auth/v1/recover?redirect_to=https%3A%2F%2Fapp.example.com%2F");assert.deepEqual(JSON.parse(requested.options.body),{email:"test@example.com"});});
test("rejects unsafe recovery redirects and malformed email before network access",async()=>{let called=false;const fetchImpl=async()=>{called=true;throw Error("unexpected");};await assert.rejects(()=>requestSupabasePasswordRecovery({...config,email:"bad",redirectTo:"https://app.example.com",fetchImpl}),e=>e.code==="INVALID_EMAIL");await assert.rejects(()=>requestSupabasePasswordRecovery({...config,email:"user@example.com",redirectTo:"https://app.example.com/continue?next=https://evil.example",fetchImpl}),e=>e.code==="SUPABASE_AUTH_CONFIG_INVALID");assert.equal(called,false);});
test("updates passwords with recovery bearer token and strong password",async()=>{let requested;const result=await updateSupabasePassword({...config,accessToken:"recovery-access-token",password:"new-strong-password",fetchImpl:async(url,options)=>{requested={url:String(url),options};return{ok:true,status:200,text:async()=>JSON.stringify({id:"user-1",email:"test@example.com"})};}});assert.deepEqual(result,{user:{id:"user-1",email:"test@example.com"}});assert.equal(requested.options.method,"PUT");assert.equal(requested.options.headers.authorization,"Bearer recovery-access-token");});
test("rejects weak password and missing recovery session",async()=>{await assert.rejects(()=>updateSupabasePassword({...config,accessToken:"token",password:"short"}),e=>e.code==="WEAK_PASSWORD");await assert.rejects(()=>updateSupabasePassword({...config,accessToken:"",password:"long-enough-password"}),e=>e.code==="RECOVERY_SESSION_REQUIRED");});
function recoveryJwt(payload){return "header."+Buffer.from(JSON.stringify(payload)).toString("base64url")+".signature";}
test("accepts only unexpired recovery claims for matching Supabase user",()=>{const payload={sub:"user-1",iss:"https://example.supabase.co/auth/v1",aud:"authenticated",role:"authenticated",exp:2000,amr:[{method:"recovery"}]};assert.equal(isSupabaseRecoveryToken({accessToken:recoveryJwt(payload),userId:"user-1",supabaseUrl:config.supabaseUrl,now:1000000}),true);assert.equal(isSupabaseRecoveryToken({accessToken:recoveryJwt({...payload,amr:[{method:"password"}]}),userId:"user-1",supabaseUrl:config.supabaseUrl,now:1000000}),false);assert.equal(isSupabaseRecoveryToken({accessToken:recoveryJwt(payload),userId:"other",supabaseUrl:config.supabaseUrl,now:1000000}),false);});
