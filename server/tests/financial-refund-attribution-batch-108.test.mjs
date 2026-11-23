import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createFinancialIntelligenceApi} from "../financial-intelligence-api.mjs";

const owner="11111111-1111-4111-8111-111111111111";
const migration=readFileSync(new URL("../../supabase/migrations/20261123230000_refund_job_attribution_batch_108.sql",import.meta.url),"utf8");

function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl){return createFinancialIntelligenceApi({
  supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",
  fetchImpl,billingEnabled:true
});}

test("refund-to-job attribution is finance-admin-only, bounded and owner-scoped",async()=>{
  const denied=api(async(url)=>{
    if(String(url).includes("/platform_admins?"))return json([]);
    throw new Error("Unauthorized caller must not reach refund attribution data");
  });
  const deniedResult=await denied.handle({method:"GET",path:"/api/admin/finance/job-refund-attribution",ownerId:owner});
  assert.equal(deniedResult.status,403);

  let rpcBody=null;
  const allowed=api(async(url,options={})=>{
    const target=String(url);
    if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
    if(target.endsWith("/rpc/financial_job_refund_attribution_report")){
      rpcBody=JSON.parse(options.body);
      return json({jobs:[],count:0,limitations:[]});
    }
    throw new Error("Unexpected request: "+target);
  });
  const result=await allowed.handle({method:"GET",path:"/api/admin/finance/job-refund-attribution",query:{limit:"25",ownerId:owner},ownerId:owner});
  assert.equal(result.status,200);
  assert.deepEqual(rpcBody,{p_actor_id:owner,p_owner_id:owner,p_limit:25});

  const invalid=await allowed.handle({method:"GET",path:"/api/admin/finance/job-refund-attribution",query:{limit:"101"},ownerId:owner});
  assert.equal(invalid.status,400);
  assert.equal(invalid.body.error.code,"FINANCIAL_REFUND_ATTRIBUTION_LIMIT_INVALID");
});

test("refund attribution SQL uses confirmed refunds only and fails closed on incomplete evidence",()=>{
  assert.match(migration,/r\.status='succeeded'/);
  assert.match(migration,/r\.status in\('requested','processing'\)/);
  assert.match(migration,/pending_not_deducted/);
  assert.match(migration,/total_consumed<=c\.total_granted_credits/);
  assert.match(migration,/unresolved_allocations=0/);
  assert.match(migration,/unresolved_source_count=0/);
  assert.match(migration,/currency_count=1/);
  assert.match(migration,/rows between unbounded preceding and current row/i);
  assert.match(migration,/revoke all on function executive_visuals\.financial_job_refund_attribution_report/);
  assert.match(migration,/grant execute on function executive_visuals\.financial_job_refund_attribution_report[\s\S]*to service_role/);
  assert.match(migration,/This report is read-only/);
});
