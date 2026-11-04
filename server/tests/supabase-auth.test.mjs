import test from "node:test";
import assert from "node:assert/strict";
import {createSupabaseAuth} from "../supabase-auth.mjs";
function response(status,body){return {ok:status>=200&&status<300,status,text:async()=>JSON.stringify(body)};}
const config={url:"https://project.supabase.co",publishableKey:"sb_publishable_test_key",redirectUrl:"https://studio.example.com/auth/callback"};
const session={access_token:"access-token-123456789012345",refresh_token:"refresh-token-123456789012345",expires_in:3600,user:{id:"user-1",email:"owner@example.com"}};
test("getUser verifies bearer tokens through the bounded Supabase adapter",async()=>{
 let call;const auth=createSupabaseAuth({...config,fetchImpl:async(url,options)=>{call={url,options};return response(200,{id:"user-1",email:"owner@example.com"});}});
 assert.deepEqual(await auth.getUser("access-token-123456789012345"),{id:"user-1",email:"owner@example.com"});
 assert.equal(call.url,"https://project.supabase.co/auth/v1/user");
 assert.equal(call.options.method,"GET");assert.equal(call.options.headers.authorization,"Bearer access-token-123456789012345");
 await assert.rejects(auth.getUser("short"),error=>error.status===401);
});
test("password sign-in uses the publishable key and returns a normalized session",async()=>{
 let call;const auth=createSupabaseAuth({...config,fetchImpl:async(url,options)=>{call={url,options};return response(200,session);}});
 const result=await auth.signInWithPassword({email:"Owner@Example.com",password:"a-long-password"});
 assert.equal(call.url,"https://project.supabase.co/auth/v1/token?grant_type=password");
 assert.equal(call.options.headers.apikey,config.publishableKey);
 assert.equal(call.options.headers.authorization,undefined);
 assert.deepEqual(JSON.parse(call.options.body),{email:"owner@example.com",password:"a-long-password"});
 assert.deepEqual(result,{accessToken:session.access_token,refreshToken:session.refresh_token,expiresIn:3600,user:{id:"user-1",email:"owner@example.com"}});
});
test("signup reports email confirmation without inventing a session",async()=>{
 const auth=createSupabaseAuth({...config,fetchImpl:async()=>response(200,{user:{id:"user-2",email:"new@example.com"}})});
 assert.deepEqual(await auth.signUp({email:"new@example.com",password:"a-long-password"}),{confirmationRequired:true,user:{id:"user-2",email:"new@example.com"}});
});
test("signup uses a validated callback URL and returns a session when confirmation is disabled",async()=>{
 let called="";const auth=createSupabaseAuth({...config,fetchImpl:async(url)=>{called=url;return response(200,session);}});
 const result=await auth.signUp({email:"new@example.com",password:"a-long-password"});
 assert.match(called,/auth\/v1\/signup\?redirect_to=/);assert.equal(result.confirmationRequired,false);assert.equal(result.refreshToken,session.refresh_token);
});
test("refresh rotates the refresh token and sign-out uses only the access token",async()=>{
 const calls=[];const auth=createSupabaseAuth({...config,fetchImpl:async(url,options)=>{calls.push({url,options});return response(200,session);}});
 const refreshed=await auth.refreshSession(session.refresh_token);await auth.signOut(refreshed.accessToken);
 assert.match(calls[0].url,/grant_type=refresh_token/);assert.deepEqual(JSON.parse(calls[0].options.body),{refresh_token:session.refresh_token});
 assert.equal(calls[1].url,"https://project.supabase.co/auth/v1/logout");assert.equal(calls[1].options.headers.authorization,"Bearer "+session.access_token);
});
test("password recovery does not expose provider response details",async()=>{
 let body;const auth=createSupabaseAuth({...config,fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return response(200,{message:"sent"});}});
 assert.deepEqual(await auth.recover({email:"owner@example.com"}),{accepted:true});assert.deepEqual(body,{email:"owner@example.com"});
});
test("password recovery completion updates only with a verified bearer session",async()=>{
 let call;const auth=createSupabaseAuth({...config,fetchImpl:async(url,options)=>{call={url,options};return response(200,{id:"user-1",email:"owner@example.com"});}});
 const result=await auth.updatePassword("verified-access-token-123456789","a-new-long-password");
 assert.deepEqual(result,{user:{id:"user-1",email:"owner@example.com"}});
 assert.equal(call.url,"https://project.supabase.co/auth/v1/user");
 assert.equal(call.options.method,"PUT");assert.equal(call.options.headers.authorization,"Bearer verified-access-token-123456789");
 assert.deepEqual(JSON.parse(call.options.body),{password:"a-new-long-password"});
 await assert.rejects(auth.updatePassword("short","short"),/valid recovery session/);
});
test("invalid URLs, credentials, passwords and refresh tokens fail closed",async()=>{
 assert.throws(()=>createSupabaseAuth({...config,url:"http://remote.example.com"}),/HTTPS/);
 assert.throws(()=>createSupabaseAuth({...config,redirectUrl:"javascript:alert(1)"}),/HTTPS/);
 const auth=createSupabaseAuth({...config,fetchImpl:async()=>response(200,session)});
 await assert.rejects(auth.signUp({email:"bad",password:"short"}),/valid email/);
 await assert.rejects(auth.refreshSession("short"),/session has expired/);
});
test("provider errors are reduced to bounded, stable errors",async()=>{
 const auth=createSupabaseAuth({...config,fetchImpl:async()=>response(400,{msg:"Invalid login credentials",code:"invalid_credentials"})});
 await assert.rejects(auth.signInWithPassword({email:"owner@example.com",password:"bad"}),error=>error.status===400&&error.code==="invalid_credentials"&&error.message==="Invalid login credentials");
});
