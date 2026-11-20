import test from "node:test";
import assert from "node:assert/strict";
import { resolveSupabaseServerKey, supabaseServerAuthHeaders } from "../supabase-server-credentials.mjs";

test("prefers the modern Supabase secret key and keeps the legacy migration fallback",()=>{
 assert.equal(resolveSupabaseServerKey({SUPABASE_SECRET_KEY:" sb_secret_modern ",SUPABASE_SERVICE_ROLE_KEY:"legacy-jwt"}),"sb_secret_modern");
 assert.equal(resolveSupabaseServerKey({SUPABASE_SERVICE_ROLE_KEY:"legacy-jwt"}),"legacy-jwt");
});
test("rejects blank and non-string Supabase credentials",()=>{
 assert.equal(resolveSupabaseServerKey({SUPABASE_SECRET_KEY:" ",SUPABASE_SERVICE_ROLE_KEY:"  "}),null);
 assert.equal(resolveSupabaseServerKey({SUPABASE_SECRET_KEY:123,SUPABASE_SERVICE_ROLE_KEY:false}),null);
});
test("modern opaque secret uses apikey only while legacy JWT keeps Bearer",()=>{
 assert.deepEqual(supabaseServerAuthHeaders("sb_secret_modern"),{apikey:"sb_secret_modern"});
 assert.deepEqual(supabaseServerAuthHeaders("legacy-jwt"),{apikey:"legacy-jwt",authorization:"Bearer legacy-jwt"});
 assert.throws(()=>supabaseServerAuthHeaders(" "),/key is required/);
});
