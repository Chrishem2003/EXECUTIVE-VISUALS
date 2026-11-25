import test from "node:test";
import assert from "node:assert/strict";
import { createFinancialIntelligenceApi } from "../financial-intelligence-api.mjs";
const owner="11111111-1111-4111-8111-111111111111";
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
test("provider cost report API diagnostic",async()=>{
 const approval={id:"approval-01",owner_id:owner,project_id:"project-01",currency:"USD",created_at:"2026-11-25T10:00:00+00:00"};
 const task={id:"task-01",approval_id:"approval-01",owner_id:owner,project_id:"project-01",shot_index:0,provider:"runway",model:"seedance-2.5",state:"succeeded",provider_task_id:"provider-task-01",currency:"USD",estimated_cost_micros:3400000,created_at:"2026-11-25T10:01:00+00:00"};
 const evidence={task_id:"task-01",provider:"runway",provider_task_id:"provider-task-01",model:"seedance-2.5",route:"runway-dev",evidence_id:"invoice-line-01",outcome:"charged",final_state:"succeeded",currency:"USD",actual_cost_micros:3500000,estimated_cost_micros:3400000,variance_micros:100000,billable_seconds:5,input_reference_count:0,audio_enabled:true,source_reference:"provider-usage-export:line-01",evidence_digest:"a".repeat(64),observed_at:"2026-11-25T10:05:00+00:00"};
 const service=createFinancialIntelligenceApi({supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",flutterwaveClientId:"client-test",flutterwaveClientSecret:"client-secret-test",webhookSecretHash:"test",billingEnabled:false,fetchImpl:async url=>{
  const target=String(url);
  if(target.includes("/platform_admins?"))return json([{role:"platform_admin"}]);
  if(target.includes("/video_generation_approvals?"))return json([approval]);
  if(target.includes("/video_generation_tasks?"))return json([task]);
  if(target.includes("/provider_outcome_evidence?"))return json([evidence]);
  throw new Error("Unexpected request: "+target);
 }});
 const result=await service.handle({method:"GET",path:"/api/admin/finance/provider-cost-reconciliation",ownerId:owner});
 assert.equal(result.status,200,JSON.stringify(result.body));
});
