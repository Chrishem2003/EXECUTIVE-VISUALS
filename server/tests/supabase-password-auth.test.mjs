import test from "node:test";
import assert from "node:assert/strict";
import {signInWithSupabasePassword,signUpWithSupabasePassword,refreshSupabaseSession,getSupabaseUser} from "../supabase-password-auth.mjs";
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
