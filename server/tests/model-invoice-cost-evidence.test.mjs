import test from "node:test";
import assert from "node:assert/strict";
import {deriveInvoiceBackedModelCostEvidence} from "../model-invoice-cost-evidence.mjs";

const periodMonth="2026-11-01";
const uuid=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
function fixture(count=5){
 const usageEvents=[],invoiceAttributions=[];
 for(let i=1;i<=count;i++){
  const id=uuid(100+i),jobId=uuid(200+i),invoice=uuid(300+i);
  usageEvents.push({id,job_id:jobId,provider:"runway",requested_model:"gen4.5",response_model:"gen4.5",operation:"video",status:"succeeded",currency:"USD",cost_basis:"provider_reported",period_month:periodMonth});
  invoiceAttributions.push({usage_event_id:id,provider:"runway",model:"gen4.5",operation:"video",amount_minor:125,currency:"USD",
   invoice_import_id:invoice,invoice_line_id:uuid(400+i),reconciliation_event_id:uuid(500+i),service_cost_event_id:uuid(600+i)});
 }
 return {periodMonth,usageEvents,invoiceAttributions,sampleComplete:true};
}

test("derives model/operation actual cost from five distinct invoice-linked jobs",()=>{
 const result=deriveInvoiceBackedModelCostEvidence(fixture());
 assert.equal(result.status,"verified_measured");
 assert.equal(result.verifiedModelGroups,1);
 assert.deepEqual(result.models[0],{
  provider:"runway",model:"gen4.5",operation:"video",currency:"USD",status:"verified_measured",
  sampleEvents:5,sampleJobs:5,matchedInvoiceEvents:5,invoiceCoverage:1,totalProviderCostMinor:625,
  averageCostPerUsageEventMinor:125,minimumSampleJobs:5,periodMonth
 });
});

test("keeps partial invoice coverage visible but withholds total actual cost",()=>{
 const data=fixture(6);
 data.invoiceAttributions=data.invoiceAttributions.filter(row=>row.usage_event_id!==uuid(103));
 const result=deriveInvoiceBackedModelCostEvidence(data);
 assert.equal(result.status,"insufficient_or_unmatched_evidence");
 assert.equal(result.models[0].status,"partial_invoice_coverage");
 assert.equal(result.models[0].invoiceCoverage,Number((5/6).toFixed(6)));
 assert.equal(result.models[0].totalProviderCostMinor,null);
});

test("rejects duplicate, mismatched, non-positive or unreferenced invoice links",()=>{
 const data=fixture();
 data.invoiceAttributions[0].model="different-model";
 data.invoiceAttributions[1].amount_minor=0;
 data.invoiceAttributions.push({...data.invoiceAttributions[2]});
 const result=deriveInvoiceBackedModelCostEvidence(data);
 assert.equal(result.models[0].status,"partial_invoice_coverage");
 assert.equal(result.models[0].totalProviderCostMinor,null);
});

test("does not certify a group when period usage contains an unclassified model event",()=>{
 const data=fixture();
 data.usageEvents.push({...data.usageEvents[0],id:uuid(999),job_id:uuid(999),response_model:null,requested_model:""});
 const result=deriveInvoiceBackedModelCostEvidence(data);
 assert.equal(result.unclassifiedUsageEvents,1);
 assert.equal(result.models[0].status,"partial_invoice_coverage");
 assert.equal(result.models[0].totalProviderCostMinor,null);
});

test("requires five distinct jobs even when there are five or more usage events",()=>{
 const data=fixture(6);
 for(const event of data.usageEvents.slice(1))event.job_id=uuid(201);
 const result=deriveInvoiceBackedModelCostEvidence(data);
 assert.equal(result.models[0].sampleEvents,6);
 assert.equal(result.models[0].sampleJobs,1);
 assert.equal(result.models[0].status,"insufficient_sample");
 assert.equal(result.models[0].totalProviderCostMinor,null);
});

test("fails closed on truncated samples and rejects invalid months",()=>{
 const truncated=deriveInvoiceBackedModelCostEvidence({...fixture(),sampleComplete:false});
 assert.equal(truncated.status,"sample_incomplete");
 assert.equal(truncated.models[0].totalProviderCostMinor,null);
 assert.throws(()=>deriveInvoiceBackedModelCostEvidence({...fixture(),periodMonth:"2026-11-22"}),{code:"MODEL_COST_EVIDENCE_PERIOD_INVALID"});
});

test("keeps model, operation and currency groups separate",()=>{
 const data=fixture();
 data.usageEvents.push({...data.usageEvents[0],id:uuid(150),job_id:uuid(250),requested_model:"seedance2_5",response_model:"seedance2_5"});
 data.invoiceAttributions.push({...data.invoiceAttributions[0],usage_event_id:uuid(150),model:"seedance2_5",invoice_line_id:uuid(450),reconciliation_event_id:uuid(550),service_cost_event_id:uuid(650)});
 const result=deriveInvoiceBackedModelCostEvidence(data);
 assert.equal(result.models.length,2);
 assert.deepEqual(result.models.map(row=>row.model),["gen4.5","seedance2_5"]);
 assert.equal(result.models[1].status,"insufficient_sample");
});
