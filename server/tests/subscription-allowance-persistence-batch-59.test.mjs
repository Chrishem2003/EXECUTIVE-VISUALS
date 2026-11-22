import test from "node:test";
import assert from "node:assert/strict";
import {createFinancialIntelligenceApi} from "../financial-intelligence-api.mjs";

const financeActor="11111111-1111-4111-8111-111111111111";
const productActor="22222222-2222-4222-8222-222222222222";
const creator="33333333-3333-4333-8333-333333333333";
const proposalId="44444444-4444-4444-8444-444444444444";
const proposalHash="a".repeat(64);

function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});}
function api(fetchImpl){return createFinancialIntelligenceApi({
 supabaseUrl:"https://project.supabase.co",serviceRoleKey:"service-role-test",
 flutterwaveClientId:"client-test",flutterwaveClientSecret:"client-secret-test",
 webhookSecretHash:"webhook-secret",billingEnabled:true,refundsEnabled:true,fetchImpl
});}

test("finance approval endpoint requires the exact billing_admin role, not a broad admin role",async()=>{
 const calls=[];
 const service=api(async(url,options={})=>{
  calls.push(String(url));
  if(String(url).includes("/platform_admins?"))return json([{role:"platform_admin"}]);
  throw new Error("Wrong-role approval must stop before database mutation.");
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-allowance-proposals/"+proposalId+"/approvals",
  ownerId:productActor,body:{stage:"finance",decision:"approved"},idempotencyKey:"finance-approval-001"});
 assert.equal(result.status,403);
 assert.equal(result.body.error.code,"SUBSCRIPTION_ALLOWANCE_APPROVAL_ROLE_REQUIRED");
 assert.equal(calls.length,1);
});

test("finance approval persists a server-authenticated actor and exact proposal hash with an audit event",async()=>{
 const calls=[];
 const service=api(async(url,options={})=>{
  const target=String(url),body=options.body?JSON.parse(options.body):null;calls.push({target,body});
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/get_subscription_allowance_approval_status"))return json({
   proposal:{id:proposalId,proposal_hash:proposalHash,created_by:creator},
   approvals:[],status:"awaiting_dual_approval",eligibleToPublish:false,publishable:false
  });
  if(target.endsWith("/rpc/get_financial_audit_head"))return json({sequence:0,headHash:"0".repeat(64)});
  if(target.endsWith("/rpc/record_subscription_allowance_approval"))return json({
   duplicate:false,status:"awaiting_dual_approval",eligibleToPublish:false,publishable:false,
   approval:{proposal_id:proposalId,stage:"finance",actor_id:financeActor,actor_role:"billing_admin",decision:"approved"}
  });
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-allowance-proposals/"+proposalId+"/approvals",
  ownerId:financeActor,body:{stage:"finance",decision:"approved",note:"Invoice sample reviewed."},idempotencyKey:"finance-approval-002"});
 assert.equal(result.status,201);
 assert.equal(result.body.approval.status,"awaiting_dual_approval");
 assert.equal(result.body.approval.publishable,false);
 const command=calls.find(x=>x.target.endsWith("/rpc/record_subscription_allowance_approval"));
 assert.equal(command.body.p_actor_id,financeActor);
 assert.equal(command.body.p_proposal_id,proposalId);
 assert.equal(command.body.p_stage,"finance");
 assert.equal(command.body.p_decision,"approved");
 assert.equal(command.body.p_event_envelope.eventType,"subscription_allowance.approval_recorded");
 assert.equal(command.body.p_event_envelope.payload.proposalHash,proposalHash);
 assert.equal(command.body.p_event_envelope.idempotencyKey,"finance-approval-002");
});

test("product approval requires platform_admin and still cannot publish an allowance",async()=>{
 const calls=[];
 const service=api(async(url,options={})=>{
  const target=String(url),body=options.body?JSON.parse(options.body):null;calls.push({target,body});
  if(target.includes("/platform_admins?"))return json([{role:"platform_admin"}]);
  if(target.endsWith("/rpc/get_subscription_allowance_approval_status"))return json({
   proposal:{id:proposalId,proposal_hash:proposalHash,created_by:creator},approvals:[],
   status:"awaiting_dual_approval",eligibleToPublish:false,publishable:false
  });
  if(target.endsWith("/rpc/get_financial_audit_head"))return json({sequence:0,headHash:"0".repeat(64)});
  if(target.endsWith("/rpc/record_subscription_allowance_approval"))return json({
   duplicate:false,status:"approved",eligibleToPublish:true,publishable:false,
   approval:{proposal_id:proposalId,stage:"product",actor_id:productActor,actor_role:"platform_admin",decision:"approved"}
  });
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-allowance-proposals/"+proposalId+"/approvals",
  ownerId:productActor,body:{stage:"product",decision:"approved"},idempotencyKey:"product-approval-001"});
 assert.equal(result.status,201);
 assert.equal(result.body.approval.status,"approved");
 assert.equal(result.body.approval.eligibleToPublish,true);
 assert.equal(result.body.approval.publishable,false);
});

test("approval API rejects browser-supplied roles and unsupported fields",async()=>{
 let calls=0;
 const service=api(async()=>{calls++;throw new Error("Invalid request must not reach database.");});
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-allowance-proposals/"+proposalId+"/approvals",
  ownerId:financeActor,body:{stage:"finance",decision:"approved",role:"billing_admin"},idempotencyKey:"invalid-approval-001"});
 assert.equal(result.status,400);
 assert.equal(result.body.error.code,"SUBSCRIPTION_ALLOWANCE_APPROVAL_INPUT_INVALID");
 assert.equal(calls,0);
});

test("proposal status endpoint returns persisted approval state without publishing credits",async()=>{
 const service=api(async(url,options={})=>{
  const target=String(url);
  if(target.endsWith("/platform_admins?select=role&user_id=eq."+financeActor+"&limit=1"))return json([{role:"billing_admin"}]);
  if(target.endsWith("/rpc/get_subscription_allowance_approval_status"))return json({
   proposal:{id:proposalId,proposal_hash:proposalHash,included_credits:120},
   approvals:[],status:"awaiting_dual_approval",eligibleToPublish:false,publishable:false
  });
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"GET",path:"/api/admin/finance/subscription-allowance-proposals/"+proposalId,ownerId:financeActor});
 assert.equal(result.status,200);
 assert.equal(result.body.approvalStatus.proposal.included_credits,120);
 assert.equal(result.body.approvalStatus.publishable,false);
});

test("proposal creation re-derives invoice evidence server-side and stores its exact source digest",async()=>{
 const uuid=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
 const events=[],attributions=[],reservations=[];
 for(let i=1;i<=5;i++){
  const jobId=uuid(100+i),usageId=uuid(200+i);
  events.push({id:usageId,job_id:jobId,status:"succeeded",period_month:"2026-11-01"});
  attributions.push({usage_event_id:usageId,amount_minor:100,currency:"USD",invoice_import_id:uuid(300+i),invoice_line_id:uuid(400+i)});
  reservations.push({job_id:jobId,actual_credits:1000,state:"settled"});
 }
 const calls=[];
 const service=api(async(url,options={})=>{
  const target=String(url),body=options.body?JSON.parse(options.body):null;calls.push({target,body});
  if(target.includes("/platform_admins?"))return json([{role:"billing_admin"}]);
  if(target.includes("ai_usage_cost_events?")&&target.includes("period_month=eq."))return json(events);
  if(target.includes("ai_usage_cost_events?")&&target.includes("job_id=in."))return json(events);
  if(target.includes("financial_cost_attribution_links?"))return json(attributions);
  if(target.includes("billing_credit_reservations?"))return json(reservations);
  if(target.endsWith("/rpc/get_financial_audit_head"))return json({sequence:0,headHash:"0".repeat(64)});
  if(target.endsWith("/rpc/create_subscription_allowance_proposal"))return json({
   duplicate:false,proposalId,proposalHash:body.p_proposal_hash,status:"awaiting_dual_approval",publishable:false
  });
  throw new Error("Unexpected request: "+target);
 });
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-allowance-proposals",
  ownerId:financeActor,idempotencyKey:"batch59-create-001",
  body:{planCode:"starter_creator",periodMonth:"2026-11-01",targetGrossMarginBps:7000,
   paymentFeeBps:350,refundReserveBps:200,fixedPaymentFeeMinor:30,supportReserveMinor:20,infrastructureReserveMinor:30}});
 assert.equal(result.status,201,JSON.stringify(result.body));
 const create=calls.find(x=>x.target.endsWith("/rpc/create_subscription_allowance_proposal"));
 assert.ok(create);
 assert.equal(create.body.p_proposal.costEvidence.sampleJobs,5);
 assert.equal(create.body.p_proposal.costEvidence.sampleCredits,5000);
 assert.equal(create.body.p_proposal.costEvidence.totalProviderCostMinor,500);
 assert.match(create.body.p_proposal.costEvidence.evidenceDigest,/^[a-f0-9]{64}$/);
 assert.equal(create.body.p_proposal_hash,result.body.proposalHash);
 assert.equal(create.body.p_event_envelope.eventType,"subscription_allowance.proposal_created");
 assert.equal(result.body.proposal.publishable,false);
});

test("proposal creation rejects browser-supplied provider cost evidence",async()=>{
 let calls=0;
 const service=api(async()=>{calls++;throw new Error("Untrusted evidence must not reach the database.");});
 const result=await service.handle({method:"POST",path:"/api/admin/finance/subscription-allowance-proposals",
  ownerId:financeActor,idempotencyKey:"batch59-create-002",
  body:{planCode:"starter_creator",providerCostPerCustomerCreditMinor:1,costEvidence:{status:"verified_measured"}}});
 assert.equal(result.status,400);
 assert.equal(result.body.error.code,"SUBSCRIPTION_ALLOWANCE_PROPOSAL_INPUT_INVALID");
 assert.equal(calls,0);
});
