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
  assert.match(migration,/p\.currency payment_currency/);
  assert.match(migration,/select r\.refund_id,r\.owner_id,r\.payment_id,r\.amount_minor,r\.currency,r\.payment_currency/);
  assert.match(migration,/c\.payment_currency=c\.currency/);
  assert.match(migration,/unmatchedConfirmedRefunds/);
  assert.match(migration,/unmatchedPendingRefunds/);
  assert.match(migration,/rows between unbounded preceding and current row/i);
  assert.match(migration,/revoke all on function executive_visuals\.financial_job_refund_attribution_report/);
  assert.match(migration,/grant execute on function executive_visuals\.financial_job_refund_attribution_report[\s\S]*to service_role/);
  assert.match(migration,/This report is read-only/);
});

test("pending refund exposure never divides by zero or reports incomplete evidence as a verified amount",()=>{
  assert.match(migration,/case when t\.total_granted_credits>0[\s\S]*?then round\(r\.amount_minor::numeric\*u\.credits_consumed\/t\.total_granted_credits\)/);
  assert.match(migration,/incomplete_pending_allocations/);
  assert.match(migration,/when coalesce\(p\.incomplete_pending_allocations,0\)>0 then 'incomplete_exposure'/);
});


test("job profitability subtracts only confirmed, complete, same-currency refunds from net contribution",async()=>{
  const owner="11111111-1111-4111-8111-111111111111";
  const jobId="22222222-2222-4222-8222-222222222222";
  const calls=[];
  const service=api(async(url,options={})=>{
    const target=String(url);
    if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
    if(target.endsWith("/rpc/financial_job_profitability_report")){
      calls.push("profitability");
      return json({count:2,jobs:[
        {jobId,ownerId:owner,revenue:{status:"verified",currencies:["USD"],recognizedMinor:1000},
          actualCost:{status:"verified",amountMinor:400,currency:"USD"},
          profitability:{status:"profitable",currency:"USD",contributionMinor:550,grossMarginPct:55}},
        {jobId:"33333333-3333-4333-8333-333333333333",ownerId:owner,
          revenue:{status:"verified",currencies:["USD"],recognizedMinor:800},
          profitability:{status:"profitable",currency:"USD",contributionMinor:500,grossMarginPct:62.5}}
      ],limitations:[]});
    }
    if(target.endsWith("/rpc/financial_job_refund_attribution_report")){
      calls.push("refunds");
      return json({count:2,jobs:[
        {jobId,confirmedRefund:{status:"verified",amountMinor:200,currency:"USD"},
          profitabilityAdjustment:{status:"subtract_from_job_revenue",confirmedRefundMinor:200}},
        {jobId:"33333333-3333-4333-8333-333333333333",
          confirmedRefund:{status:"incomplete",amountMinor:null,currency:"USD"},
          profitabilityAdjustment:{status:"withheld_incomplete_refund_attribution",confirmedRefundMinor:null}}
      ],unmatchedConfirmedRefunds:{count:0,amountByCurrency:[]},unmatchedPendingRefunds:{count:1},limitations:["Incomplete evidence fixture"]});
    }
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handle({method:"GET",path:"/api/admin/finance/job-profitability",ownerId:owner});
  assert.equal(result.status,200);
  assert.deepEqual(calls,["profitability","refunds"]);
  const adjusted=result.body.jobProfitability.jobs[0];
  assert.equal(adjusted.netProfitability.status,"verified");
  assert.equal(adjusted.netProfitability.confirmedRefundMinor,200);
  assert.equal(adjusted.netProfitability.recognizedRevenueMinorAfterRefund,800);
  assert.equal(adjusted.netProfitability.contributionMinorAfterRefund,350);
  assert.equal(adjusted.netProfitability.grossMarginPct,43.75);
  const withheld=result.body.jobProfitability.jobs[1];
  assert.equal(withheld.netProfitability.status,"withheld_incomplete_refund_attribution");
  assert.equal(withheld.netProfitability.contributionMinorAfterRefund,null);
  assert.equal(result.body.jobProfitability.refundAttribution.unmatchedPendingRefunds.count,1);
});

test("job profitability withholds net margin when refund currency differs from revenue currency",async()=>{
  const owner="11111111-1111-4111-8111-111111111111";
  const service=api(async(url)=>{
    const target=String(url);
    if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
    if(target.endsWith("/rpc/financial_job_profitability_report"))return json({count:1,jobs:[
      {jobId:"44444444-4444-4444-8444-444444444444",revenue:{status:"verified",currencies:["USD"],recognizedMinor:1000},
        profitability:{status:"profitable",currency:"USD",contributionMinor:500,grossMarginPct:50}}
    ],limitations:[]});
    if(target.endsWith("/rpc/financial_job_refund_attribution_report"))return json({count:1,jobs:[
      {jobId:"44444444-4444-4444-8444-444444444444",confirmedRefund:{status:"verified",amountMinor:100,currency:"UGX"},
        profitabilityAdjustment:{status:"subtract_from_job_revenue",confirmedRefundMinor:100}}
    ],limitations:[]});
    throw new Error("Unexpected request: "+target);
  });
  const result=await service.handle({method:"GET",path:"/api/admin/finance/job-profitability",ownerId:owner});
  assert.equal(result.status,200);
  assert.equal(result.body.jobProfitability.jobs[0].netProfitability.status,"currency_mismatch");
  assert.equal(result.body.jobProfitability.jobs[0].netProfitability.contributionMinorAfterRefund,null);
});
