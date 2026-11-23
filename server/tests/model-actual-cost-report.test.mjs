import test from "node:test";
import assert from "node:assert/strict";
import {loadModelActualCostReport,validateModelActualCostPeriod} from "../model-actual-cost-report.mjs";

const month="2026-11-01";
const uuid=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
function fixture(){
 const usageEvents=[],invoiceAttributions=[];
 for(let i=1;i<=5;i++){
  const id=uuid(100+i);
  usageEvents.push({id,job_id:uuid(200+i),period_month:month,provider:"runway",requested_model:"gen4.5",response_model:"gen4.5",operation:"video",currency:"USD",cost_basis:"provider_reported"});
  invoiceAttributions.push({usage_event_id:id,provider:"runway",model:"gen4.5",operation:"video",amount_minor:125,currency:"USD",
   invoice_import_id:uuid(300+i),invoice_line_id:uuid(400+i),reconciliation_event_id:uuid(500+i),service_cost_event_id:uuid(600+i)});
 }
 return {usageEvents,invoiceAttributions};
}

test("loads a complete invoice-backed report without accepting browser-supplied totals",async()=>{
 const data=fixture(),calls=[];
 const report=await loadModelActualCostReport({periodMonth:month,dbRequest:async path=>{
  calls.push(path);
  return path.startsWith("ai_usage_cost_events")?{data:data.usageEvents}:{data:data.invoiceAttributions};
 }});
 assert.equal(report.status,"verified_measured");
 assert.equal(report.models[0].totalProviderCostMinor,625);
 assert.equal(report.models[0].sampleJobs,5);
 assert.equal(calls.length,2);
 assert.match(calls[0],/limit=1000$/);
 assert.match(calls[1],/usage_event_id=in\.\(/);
});

test("fails closed when the usage sample reaches the bounded query limit",async()=>{
 let calls=0;
 const report=await loadModelActualCostReport({periodMonth:month,dbRequest:async()=>{calls++;return {data:Array.from({length:1000},(_,i)=>({id:uuid(i+1)}))};}});
 assert.equal(calls,1);
 assert.equal(report.status,"sample_incomplete");
 assert.equal(report.sampleComplete,false);
 assert.equal(report.models.length,0);
});

test("fails closed when invoice attribution reaches the bounded query limit",async()=>{
 const data=fixture();let calls=0;
 const report=await loadModelActualCostReport({periodMonth:month,dbRequest:async path=>{
  calls++;
  return path.startsWith("ai_usage_cost_events")?{data:data.usageEvents}:{data:Array.from({length:1000},(_,i)=>data.invoiceAttributions[i%5])};
 }});
 assert.equal(calls,2);
 assert.equal(report.status,"sample_incomplete");
 assert.equal(report.models.length,0);
});

test("rejects invalid periods before database access",async()=>{
 let calls=0;
 await assert.rejects(()=>loadModelActualCostReport({periodMonth:"2026-11-23",dbRequest:async()=>{calls++;return {data:[]};}}),{code:"MODEL_ACTUAL_COST_PERIOD_INVALID"});
 assert.equal(calls,0);
 assert.throws(()=>validateModelActualCostPeriod("2026-02-30"),{code:"MODEL_ACTUAL_COST_PERIOD_INVALID"});
});

test("returns an explicit no-usage report for an empty period",async()=>{
 const report=await loadModelActualCostReport({periodMonth:month,dbRequest:async()=>({data:[]})});
 assert.equal(report.status,"no_usage_events");
 assert.equal(report.sampleComplete,true);
});
