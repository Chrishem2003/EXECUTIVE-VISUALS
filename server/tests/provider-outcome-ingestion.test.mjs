import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createProviderOutcomeIngestion } from "../provider-outcome-ingestion.mjs";

const token="server-to-server-ingest-token-with-at-least-32-bytes";
const secret="provider-adapter-hmac-secret-with-at-least-32-bytes";
const expectedTask={id:"11111111-1111-4111-8111-111111111111",job_id:"job-01",provider:"runway",provider_task_id:"provider-task-01",model:"seedance-2.5",state:"succeeded",estimated_cost_micros:3400000,currency:"USD"};
const baseEnvelope={
 taskId:expectedTask.id,evidenceId:"evt-01",provider:"runway",providerAccountId:"acct-01",
 providerTaskId:"provider-task-01",jobId:"job-01",model:"seedance-2.5",route:"runway-dev",
 outcome:"charged",finalState:"succeeded",currency:"USD",amountMinor:340,
 billableSeconds:5,inputReferenceCount:0,audioEnabled:true,
 sourceReference:"provider-invoice:line-01",observedAt:"2026-11-25T12:00:00.000Z"
};
function canonical(value){
 if(value===null||typeof value!=="object")return JSON.stringify(value);
 if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
 return "{"+Object.keys(value).filter(k=>k!=="signature").sort().map(k=>JSON.stringify(k)+":"+canonical(value[k])).join(",")+"}";
}
function signed(overrides={}){
 const envelope={...baseEnvelope,...overrides};
 envelope.signature=createHmac("sha256",secret).update(canonical(envelope)).digest("hex");
 return envelope;
}
function makeFetch({task=expectedTask,rpcRows=[{evidence_row_id:"evidence-01",replayed:false,actual_cost_micros:3400000,estimated_cost_micros:3400000,variance_micros:0}],rpcStatus=200}={}){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  calls.push({url,options});
  if(url.includes("/video_generation_tasks?")){
   return{ok:true,status:200,text:async()=>JSON.stringify(task?[task]:[])};
  }
  return{ok:rpcStatus>=200&&rpcStatus<300,status:rpcStatus,text:async()=>JSON.stringify(rpcRows)};
 };
 return{fetchImpl,calls};
}
function create(fetchImpl,extra={}){return createProviderOutcomeIngestion({
 supabaseUrl:"https://example.supabase.co",serviceRoleKey:"service-role-key",
 ingestToken:token,verificationSecret:secret,
 providerAccountIds:{runway:"acct-01"},providerRoutes:{runway:"runway-dev"},
 adapterId:"runway-dev",adapterVersion:"2026-11-25.1",
 fetchImpl,now:()=>Date.parse("2026-11-25T12:01:00.000Z"),...extra
});}

test("authenticates the worker channel, loads task identity, verifies HMAC and persists USD micro-cost",async()=>{
 const mock=makeFetch(),service=create(mock.fetchImpl);
 const result=await service.ingest({authorization:"Bearer "+token,envelope:signed()});
 assert.equal(result.accepted,true);
 assert.equal(result.actualCostMicros,3400000);
 assert.equal(result.customerCreditsChanged,false);
 assert.equal(mock.calls.length,2);
 const rpc=JSON.parse(mock.calls[1].options.body);
 assert.equal(rpc.p_task_id,expectedTask.id);
 assert.equal(rpc.p_actual_cost_micros,3400000);
 assert.equal(rpc.p_provider_account_id,"acct-01");
 assert.equal(mock.calls[1].options.headers["content-profile"],"executive_visuals");
});

test("rejects missing or incorrect worker token before reading task state",async()=>{
 const mock=makeFetch(),service=create(mock.fetchImpl);
 await assert.rejects(()=>service.ingest({authorization:"Bearer wrong",envelope:signed()}),{code:"PROVIDER_OUTCOME_INGEST_UNAUTHORIZED"});
 assert.equal(mock.calls.length,0);
});

test("rejects task identity mismatch even when envelope HMAC is valid",async()=>{
 const mock=makeFetch({task:{...expectedTask,provider_task_id:"another-task"}}),service=create(mock.fetchImpl);
 await assert.rejects(()=>service.ingest({authorization:"Bearer "+token,envelope:signed()}),{code:"PROVIDER_OUTCOME_IDENTITY_MISMATCH"});
 assert.equal(mock.calls.length,1);
});

test("rejects a provider account or route not in server configuration",async()=>{
 const mock=makeFetch(),service=create(mock.fetchImpl,{providerAccountIds:{runway:"different-account"}});
 await assert.rejects(()=>service.ingest({authorization:"Bearer "+token,envelope:signed()}),{code:"PROVIDER_OUTCOME_IDENTITY_MISMATCH"});
});

test("rejects a signed terminal state that differs from the durable task state",async()=>{
 const mock=makeFetch(),service=create(mock.fetchImpl);
 await assert.rejects(()=>service.ingest({authorization:"Bearer "+token,envelope:signed({finalState:"failed"})}),{code:"PROVIDER_OUTCOME_IDENTITY_MISMATCH"});
 assert.equal(mock.calls.length,1);
});

test("rejects unsupported currency rather than guessing minor-unit conversion",async()=>{
 const mock=makeFetch({task:{...expectedTask,currency:"JPY"}}),service=create(mock.fetchImpl);
 await assert.rejects(()=>service.ingest({authorization:"Bearer "+token,envelope:signed({currency:"JPY"})}),{code:"PROVIDER_OUTCOME_CURRENCY_UNSUPPORTED"});
});

test("rejects task not found and incomplete submitted identity",async()=>{
 const missing=makeFetch({task:null}),missingService=create(missing.fetchImpl);
 await assert.rejects(()=>missingService.ingest({authorization:"Bearer "+token,envelope:signed()}),{code:"PROVIDER_OUTCOME_TASK_NOT_FOUND"});
 const incomplete=makeFetch({task:{...expectedTask,provider_task_id:null}}),incompleteService=create(incomplete.fetchImpl);
 await assert.rejects(()=>incompleteService.ingest({authorization:"Bearer "+token,envelope:signed()}),{code:"PROVIDER_OUTCOME_TASK_NOT_SUBMITTED"});
});

test("persists authenticated no-charge evidence as zero provider cost without releasing credits",async()=>{
 const mock=makeFetch({task:{...expectedTask,state:"cancelled"},rpcRows:[{evidence_row_id:"evidence-no-charge",replayed:false,actual_cost_micros:0,estimated_cost_micros:3400000,variance_micros:-3400000}]});
 const envelope=signed({evidenceId:"evt-no-charge",outcome:"no_charge",finalState:"cancelled",amountMinor:0,billableSeconds:0});
 const result=await create(mock.fetchImpl).ingest({authorization:"Bearer "+token,envelope});
 const rpc=JSON.parse(mock.calls[1].options.body);
 assert.equal(result.outcome,"no_charge");
 assert.equal(rpc.p_actual_cost_micros,0);
 assert.equal(result.customerCreditsChanged,false);
});

test("persists unknown outcome without fabricating actual cost",async()=>{
 const mock=makeFetch({task:{...expectedTask,state:"failed"},rpcRows:[{evidence_row_id:"evidence-unknown",replayed:false,actual_cost_micros:null,estimated_cost_micros:3400000,variance_micros:null}]});
 const envelope=signed({evidenceId:"evt-unknown",outcome:"unknown",finalState:"failed",amountMinor:null,billableSeconds:null,inputReferenceCount:null,audioEnabled:null});
 const result=await create(mock.fetchImpl).ingest({authorization:"Bearer "+token,envelope});
 const rpc=JSON.parse(mock.calls[1].options.body);
 assert.equal(result.outcome,"unknown");
 assert.equal(rpc.p_actual_cost_micros,null);
 assert.equal(rpc.p_billable_seconds,null);
 assert.equal(rpc.p_input_reference_count,null);
 assert.equal(rpc.p_audio_enabled,null);
 assert.equal(result.customerCreditsChanged,false);
});

test("rejects a route that differs from the server-configured adapter route",async()=>{
 const mock=makeFetch(),service=create(mock.fetchImpl);
 await assert.rejects(()=>service.ingest({authorization:"Bearer "+token,envelope:signed({route:"unapproved-route"})}),{code:"PROVIDER_OUTCOME_IDENTITY_MISMATCH"});
 assert.equal(mock.calls.length,1);
});

test("rejects invalid HMAC before attempting durable evidence persistence",async()=>{
 const mock=makeFetch(),service=create(mock.fetchImpl);
 const envelope=signed();envelope.amountMinor=1;
 await assert.rejects(()=>service.ingest({authorization:"Bearer "+token,envelope}),{code:"PROVIDER_OUTCOME_SIGNATURE_INVALID"});
 assert.equal(mock.calls.length,1);
});

test("returns exact idempotent replay result from durable RPC",async()=>{
 const mock=makeFetch({rpcRows:[{evidence_row_id:"evidence-01",replayed:true,actual_cost_micros:3400000,estimated_cost_micros:3400000,variance_micros:0}]});
 const result=await create(mock.fetchImpl).ingest({authorization:"Bearer "+token,envelope:signed()});
 assert.equal(result.replayed,true);
});

test("rejects malformed and underlength server configuration",()=>{
 assert.throws(()=>createProviderOutcomeIngestion({supabaseUrl:"https://example.supabase.co",serviceRoleKey:"key",ingestToken:"short",verificationSecret:secret,providerAccountIds:{runway:"acct-01"},providerRoutes:{runway:"runway-dev"},adapterId:"runway",adapterVersion:"1"}),{code:"PROVIDER_OUTCOME_INGESTION_NOT_CONFIGURED"});
});
