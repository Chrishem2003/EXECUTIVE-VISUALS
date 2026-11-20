import test from "node:test";
import assert from "node:assert/strict";
import { resolveSupabaseServerKey, supabaseServerAuthHeaders } from "../supabase-server-credentials.mjs";

test("prefers the modern Supabase secret key",()=>{
 assert.equal(resolveSupabaseServerKey({SUPABASE_SECRET_KEY:"sb_secret_modern",SUPABASE_SERVICE_ROLE_KEY:"legacy-jwt"}),"sb_secret_modern");
});
test("supports the legacy service-role key during migration",()=>{
 assert.equal(resolveSupabaseServerKey({SUPABASE_SERVICE_ROLE_KEY:"legacy-jwt"}),"legacy-jwt");
});
test("trims configured values and rejects blank keys",()=>{
 assert.equal(resolveSupabaseServerKey({SUPABASE_SECRET_KEY:"  sb_secret_modern  "}),"sb_secret_modern");
 assert.equal(resolveSupabaseServerKey({SUPABASE_SECRET_KEY:" ",SUPABASE_SERVICE_ROLE_KEY:"  "}),null);
});
test("does not coerce non-string environment values into credentials",()=>{
 assert.equal(resolveSupabaseServerKey({SUPABASE_SECRET_KEY:123,SUPABASE_SERVICE_ROLE_KEY:false}),null);
});

test("modern opaque secret uses apikey only while legacy JWT keeps Bearer",()=>{
 assert.deepEqual(supabaseServerAuthHeaders("sb_secret_modern"),{apikey:"sb_secret_modern"});
 assert.deepEqual(supabaseServerAuthHeaders("legacy-jwt"),{apikey:"legacy-jwt",authorization:"Bearer legacy-jwt"});
 assert.throws(()=>supabaseServerAuthHeaders(" "),/key is required/);
});
