import test from "node:test";
import assert from "node:assert/strict";
import {deriveInvoiceBackedCreditCostEvidence} from "../subscription-credit-cost-evidence.mjs";

const periodMonth="2026-11-01";
const uuid=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
function fixture(count=5){
 const usageEvents=[],invoiceAttributions=[],creditReservations=[];
 for(let i=1;i<=count;i++){
  const jobId=uuid(100+i),usageId=uuid(200+i);
  usageEvents.push({id:usageId,job_id:jobId,status:"succeeded",period_month:periodMonth});
  invoiceAttributions.push({usage_event_id:usageId,amount_minor:100,currency:"USD",invoice_import_id:uuid(300+i),invoice_line_id:uuid(400+i)});
  creditReservations.push({job_id:jobId,actual_credits:1000,state:"settled"});
 }
 return {periodMonth,usageEvents,invoiceAttributions,creditReservations};
}

test("derives conservative invoice-backed USD cost per platform credit from five complete jobs",()=>{
 const result=deriveInvoiceBackedCreditCostEvidence(fixture());
 assert.equal(result.status,"verified_measured");
 assert.equal(result.sampleJobs,5);
 assert.equal(result.sampleCredits,5000);
 assert.equal(result.totalProviderCostMinor,500);
 assert.equal(result.providerCostPerCustomerCreditMinor,1);
 assert.equal(result.evidence.approved,false);
});

test("fails closed for insufficient, ambiguous, non-USD, unsettled and incomplete evidence",()=>{
 const data=fixture(6);
 data.invoiceAttributions=data.invoiceAttributions.filter(row=>row.usage_event_id!==uuid(202));
 data.invoiceAttributions.find(row=>row.usage_event_id===uuid(203)).currency="UGX";
 data.creditReservations.find(row=>row.job_id===uuid(104)).state="reserved";
 const result=deriveInvoiceBackedCreditCostEvidence(data);
 assert.equal(result.status,"insufficient_sample");
 assert.equal(result.providerCostPerCustomerCreditMinor,null);
 const truncated=deriveInvoiceBackedCreditCostEvidence({...fixture(),sampleComplete:false});
 assert.equal(truncated.status,"sample_incomplete");
 assert.equal(truncated.evidence,null);
});

test("rejects malformed reporting month and duplicate invoice/reservation links",()=>{
 assert.throws(()=>deriveInvoiceBackedCreditCostEvidence({...fixture(),periodMonth:"2026-11-22"}),{code:"SUBSCRIPTION_COST_EVIDENCE_PERIOD_INVALID"});
 const data=fixture();
 data.invoiceAttributions.push({...data.invoiceAttributions[0]});
 const result=deriveInvoiceBackedCreditCostEvidence(data);
 assert.equal(result.sampleJobs,4);
 assert.equal(result.providerCostPerCustomerCreditMinor,null);
});
