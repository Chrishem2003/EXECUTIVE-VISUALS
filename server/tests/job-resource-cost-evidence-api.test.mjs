import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createFinancialIntelligenceApi} from "../financial-intelligence-api.mjs";

const owner="77777777-7777-4777-8777-777777777777";
const job="11111111-1111-4111-8111-111111111111";
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl){return createFinancialIntelligenceApi({supabaseUrl:"https://project.supabase.co",
 serviceRoleKey:"service-role-test",billingEnabled:true,flutterwaveClientId:"client-test",
 flutterwaveClientSecret:"client-secret-test",fetchImpl});}
const usage={id:"22222222-2222-4222-8222-222222222222",job_id:job,owner_id:owner,
 project_id:"88888888-8888-4888-8888-888888888888",provider:"executive-visuals-worker",
 resource_type:"storage_gb_day",quantity:2,unit:"gb_day",currency:"USD",
 occurred_at:"2026-11-20T12:00:00.000Z",evidence:{source:"cloud_provider_meter"}};
const rate={id:"33333333-3333-4333-8333-333333333333",provider:"executive-visuals-worker",
 resource_type:"storage_gb_day",unit:"gb_day",currency:"USD",rate_minor_per_unit:3,
 effective_from:"2026-11-01T00:00:00.000Z",effective_to:null,source_type:"cloud_contract",
 source_reference:"contract-rate-2026"};

test("job resource evidence endpoint is finance-admin-only",async()=>{
 const calls=[];
 const service=api(async url=>{calls.push(String(url));if(String(url).includes("/platform_admins?"))return json([{role:"support"}]);throw new Error("Must not read financial sources.");});
 const result=await service.handle({method:"GET",path:"/api/admin/finance/job-resource-cost-evidence",ownerId:owner,query:{jobId:job}});
 assert.equal(result.status,403);
 assert.equal(calls.length,1);
});

test("job resource evidence endpoint validates UUID before reading usage",async()=>{
 const calls=[];
 const service=api(async url=>{calls.push(String(url));if(String(url).includes("/platform_admins?"))return json([{role:"owner"}]);throw new Error("Invalid UUID must not read usage.");});
 const result=await service.handle({method:"GET",path:"/api/admin/finance/job-resource-cost-evidence",ownerId:owner,query:{jobId:"invalid"}});
 assert.equal(result.status,400);
 assert.equal(result.body.error.code,"JOB_RESOURCE_EVIDENCE_JOB_ID_INVALID");
 assert.equal(calls.length,1);
});

test("job resource evidence endpoint reads only owner-scoped usage and existing rates",async()=>{
 const calls=[];
 const service=api(async url=>{
  const target=new URL(String(url));calls.push(target.pathname+target.search);
  if(target.pathname.endsWith("/platform_admins"))return json([{role:"owner"}]);
  if(target.pathname.endsWith("/ai_resource_usage_events"))return json([usage]);
  if(target.pathname.endsWith("/ai_resource_rate_cards"))return json([rate]);
  throw new Error("Unexpected source read: "+target);
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/job-resource-cost-evidence",ownerId:owner,query:{jobId:job}});
 assert.equal(result.status,200);
 assert.equal(result.body.resourceCostEvidence.categories[0].status,"verified_historical_actual");
 assert.equal(result.body.resourceCostEvidence.categories[0].amountMinor,6);
 assert.equal(result.body.resourceCostEvidence.dispatchEvidenceEligible,false);
 assert.equal(calls.length,3);
 assert.match(calls[1],/owner_id=eq\./);
});

test("job resource evidence route is read-only and never posts a ledger or payment action",async()=>{
 const source=await readFile(new URL("../financial-intelligence-api.mjs",import.meta.url),"utf8");
 const start=source.indexOf('path==="/api/admin/finance/job-resource-cost-evidence"');
 const end=source.indexOf('path==="/api/admin/finance/job-cost-evidence-readiness"',start);
 const route=source.slice(start,end);
 assert.match(route,/method==="GET"/);
 assert.doesNotMatch(route,/method==="POST"|rpc\(|credit_ledger|payment|insert|PATCH/);
});
