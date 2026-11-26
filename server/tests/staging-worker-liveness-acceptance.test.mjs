import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const script=fileURLToPath(new URL("../../scripts/verify-cloud-worker-heartbeat-process.mjs",import.meta.url));

test("worker liveness acceptance refuses to run without an explicit staging project",()=>{
 const result=spawnSync(process.execPath,[script],{encoding:"utf8",env:{PATH:process.env.PATH||"",HOME:process.env.HOME||""}});
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/approved staging Supabase project/);
});

test("worker liveness acceptance rejects production or unrelated Supabase project URLs",()=>{
 const result=spawnSync(process.execPath,[script],{encoding:"utf8",env:{
  PATH:process.env.PATH||"",HOME:process.env.HOME||"",
  SUPABASE_STAGING_URL:"https://production-project.supabase.co",
  SUPABASE_STAGING_SECRET_KEY:"placeholder-never-used"
 }});
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/approved staging Supabase project/);
 assert.equal(result.stdout.includes("placeholder-never-used"),false);
});
