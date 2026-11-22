import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createProjectCreditPoolApi} from "../project-credit-pool-api.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const project="323e4567-e89b-42d3-a456-426614174000";
const member="223e4567-e89b-42d3-a456-426614174000";

function fixture({status=200,payload={ok:true}}={}){
 const calls=[];
 const api=createProjectCreditPoolApi({
  url:"https://example.supabase.co",serviceRoleKey:"secret",
  fetchImpl:async(url,options)=>{calls.push({url,options});return{ok:status>=200&&status<300,status,async text(){return JSON.stringify(payload);}};}
 });
 return{api,calls};
}

test("project credit pool operations use the private executive_visuals RPC schema and server credentials",async()=>{
 const f=fixture({payload:{projectId:project,status:"active"}});
 await f.api.configure({ownerId:owner,projectId:project,monthlySpendLimitCredits:500});
 const call=f.calls[0];
 assert.equal(call.url,"https://example.supabase.co/rest/v1/rpc/configure_project_credit_pool");
 assert.equal(call.options.method,"POST");
 assert.equal(call.options.headers.apikey,"secret");
 assert.equal(call.options.headers.authorization,"Bearer secret");
 assert.equal(call.options.headers["content-profile"],"executive_visuals");
 assert.deepEqual(JSON.parse(call.options.body),{p_owner_id:owner,p_project_id:project,p_monthly_spend_limit_credits:500});
});

test("project pool top-ups and member policies pass explicit idempotency and bounded policy values",async()=>{
 const f=fixture({payload:[{pool_balance:100,personal_balance:900,replayed:false}]});
 await f.api.fund({ownerId:owner,projectId:project,credits:100,idempotencyKey:"agency-topup-0001"});
 await f.api.setMemberPolicy({ownerId:owner,projectId:project,memberId:member,monthlyLimitCredits:250,status:"paused"});
 assert.ok(f.calls[0].url.endsWith("/rpc/fund_project_credit_pool"));
 assert.deepEqual(JSON.parse(f.calls[0].options.body),{p_owner_id:owner,p_project_id:project,p_credits:100,p_idempotency_key:"agency-topup-0001"});
 assert.ok(f.calls[1].url.endsWith("/rpc/configure_project_credit_pool_member_policy"));
 assert.deepEqual(JSON.parse(f.calls[1].options.body),{p_owner_id:owner,p_project_id:project,p_member_id:member,p_monthly_limit_credits:250,p_status:"paused"});
});

test("member usage is read through the owner-scoped database function",async()=>{
 const f=fixture({payload:[{member_id:member,role:"editor",status:"active",monthly_limit_credits:250,used_this_month:50,remaining_this_month:200}]});
 const result=await f.api.listMemberUsage({ownerId:owner,projectId:project});
 assert.equal(result[0].remaining_this_month,200);
 assert.ok(f.calls[0].url.endsWith("/rpc/list_project_credit_pool_member_usage"));
});

test("invalid IDs, credit amounts, limits, statuses and idempotency keys fail before network access",async()=>{
 const f=fixture();
 await assert.rejects(()=>f.api.configure({ownerId:"bad",projectId:project}));
 await assert.rejects(()=>f.api.fund({ownerId:owner,projectId:project,credits:0,idempotencyKey:"agency-topup-0001"}));
 await assert.rejects(()=>f.api.fund({ownerId:owner,projectId:project,credits:10,idempotencyKey:"short"}));
 await assert.rejects(()=>f.api.setMemberPolicy({ownerId:owner,projectId:project,memberId:member,monthlyLimitCredits:-1}));
 await assert.rejects(()=>f.api.setMemberPolicy({ownerId:owner,projectId:project,memberId:member,status:"unlimited"}));
 assert.equal(f.calls.length,0);
});

test("database failures retain safe status and machine-readable error codes",async()=>{
 const f=fixture({status:403,payload:{code:"42501",message:"PROJECT_CREDIT_POOL_OWNER_REQUIRED"}});
 await assert.rejects(()=>f.api.configure({ownerId:owner,projectId:project}),error=>error.status===403&&error.code==="PROJECT_CREDIT_POOL_OWNER_REQUIRED");
});

test("service rejects non-HTTPS Supabase origins and missing credentials",()=>{
 assert.throws(()=>createProjectCreditPoolApi({url:"http://example.supabase.co",serviceRoleKey:"secret"}));
 assert.throws(()=>createProjectCreditPoolApi({url:"https://example.supabase.co"}));
});

test("cloud project routes parse mutation bodies and expose the guarded shared credit controls to the cloud workspace",async()=>{
 const index=await readFile(new URL("../index.mjs",import.meta.url),"utf8");
 const cloudApi=await readFile(new URL("../cloud-timeline-api.mjs",import.meta.url),"utf8");
 const app=await readFile(new URL("../../src/platform/app.ts",import.meta.url),"utf8");
 assert.match(index,/path\.includes\("\/credit-pool"\).*req\.method==="POST"\|\|req\.method==="PUT"/);
 assert.match(index,/PROJECT_CREDIT_POOL_API_ENABLED/);
 assert.match(cloudApi,/\/api\/cloud\/projects\/\(\[0-9a-f-\]\+\)\/credit-pool/);
 assert.match(cloudApi,/project\.ownerId!==ownerId/);
 assert.match(app,/project-credit-pool-configure/);
 assert.match(app,/project-credit-pool-fund/);
 assert.match(app,/data-project-credit-member-policy/);
});
