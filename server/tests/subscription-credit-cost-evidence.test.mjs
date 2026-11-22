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

test("derives a conservative blended USD-cent cost per platform credit from five complete invoiced jobs",()=>{
 const result=deriveInvoiceBackedCreditCostEvidence(fixture());
 assert.equal(result.status,"verified_measured");
 assert.equal(result.sampleJobs,5);
 assert.equal(result.sampleCredits,5000);
 assert.equal(result.totalProviderCostMinor,500);
 assert.equal(result.providerCostPerCustomerCreditMinor,1);
 assert.equal(result.evidence.status,"approved_measured");
 assert.equal(result.evidence.approved,true);
 assert.equal(result.evidence.rateCardVersion,"invoice-attribution-derived-v1");
});

test("excludes partial, ambiguous, non-USD and unsettled jobs instead of estimating missing costs",()=>{
 const data=fixture(9);
 data.invoiceAttributions=data.invoiceAttributions.filter(x=>x.usage_event_id!==uuid(202));
 data.invoiceAttributions.push({...data.invoiceAttributions.find(x=>x.usage_event_id===uuid(203)),invoice_line_id:uuid(999)});
 data.invoiceAttributions.find(x=>x.usage_event_id===uuid(204)).currency="UGX";
 data.creditReservations.find(x=>x.job_id===uuid(105)).state="reserved";
 data.creditReservations.push({...data.creditReservations[0]});
 const result=deriveInvoiceBackedCreditCostEvidence(data);
 assert.equal(result.sampleJobs,5);
 assert.equal(result.excludedJobs,4);
 assert.equal(result.providerCostPerCustomerCreditMinor,1);
});

test("requires at least five fully reconciled jobs before producing cost evidence",()=>{
 const result=deriveInvoiceBackedCreditCostEvidence(fixture(4));
 assert.equal(result.status,"insufficient_sample");
 assert.equal(result.sampleJobs,4);
 assert.equal(result.providerCostPerCustomerCreditMinor,null);
 assert.equal(result.evidence,null);
});

test("fails closed when the reporting sample exceeds the bounded query window",()=>{
 const result=deriveInvoiceBackedCreditCostEvidence({...fixture(5),sampleComplete:false});
 assert.equal(result.status,"sample_incomplete");
 assert.equal(result.providerCostPerCustomerCreditMinor,null);
 assert.equal(result.evidence,null);
});

test("does not count provider estimates, unsuccessful jobs, duplicate invoice links or duplicate reservations",()=>{
 const data=fixture(5);
 data.usageEvents[0].status="failed";
 data.invoiceAttributions.push({...data.invoiceAttributions[1]});
 data.creditReservations.push({...data.creditReservations[2]});
 const result=deriveInvoiceBackedCreditCostEvidence(data);
 assert.equal(result.sampleJobs,2);
 assert.equal(result.status,"insufficient_sample");
 assert.equal(result.providerCostPerCustomerCreditMinor,null);
});

test("requires a valid month boundary and invoice-backed USD minor-unit records",()=>{
 assert.throws(()=>deriveInvoiceBackedCreditCostEvidence({...fixture(),periodMonth:"2026-11-22"}),{code:"SUBSCRIPTION_COST_EVIDENCE_PERIOD_INVALID"});
 const data=fixture();
 data.invoiceAttributions[0].invoice_import_id="not-a-uuid";
 const result=deriveInvoiceBackedCreditCostEvidence(data);
 assert.equal(result.sampleJobs,4);
 assert.equal(result.providerCostPerCustomerCreditMinor,null);
});
