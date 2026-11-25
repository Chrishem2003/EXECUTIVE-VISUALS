import test from "node:test";
import assert from "node:assert/strict";
import { buildJobCostSourceEvidenceReadiness } from "../job-cost-source-evidence-readiness.mjs";

const job="11111111-1111-4111-8111-111111111111";
const usageId="22222222-2222-4222-8222-222222222222";
const invoiceId="33333333-3333-4333-8333-333333333333";
const lineId="44444444-4444-4444-8444-444444444444";
const reconId="55555555-5555-4555-8555-555555555555";
const costId="66666666-6666-4666-8666-666666666666";
const owner="77777777-7777-4777-8777-777777777777";
const project="88888888-8888-4888-8888-888888888888";
const now=Date.parse("2026-11-25T12:00:00.000Z");
function fixture(overrides={}){
 const usage={id:usageId,job_id:job,owner_id:owner,project_id:project,provider:"runway",
  requested_model:"seedance-2.5",response_model:"seedance-2.5",operation:"video",
  status:"failed",cost_basis:"provider_reported",currency:"USD",cost_minor:340,
  invoice_line_reference:"line-001",period_month:"2026-11-01"};
 const invoice={id:invoiceId,provider:"runway",invoice_reference:"inv-001",currency:"USD",
  total_minor:340,imported_line_count:1,matched_line_count:0,reconciliation_status:"pending",
  source_fingerprint:"a".repeat(64),imported_at:"2026-11-24T12:00:00.000Z"};
 const line={id:lineId,import_id:invoiceId,provider_line_reference:"line-001",
  provider:"runway",model:"seedance-2.5",operation:"video",currency:"USD",amount_minor:340,
  matched_usage_event_id:null,match_status:"unmatched"};
 const recon={id:reconId,invoice_import_id:invoiceId,invoice_line_id:lineId,
  usage_event_id:usageId,match_status:"matched",candidate_count:1,
  expected_amount_minor:340,observed_amount_minor:340,currency:"USD"};
 const cost={id:costId,period_month:"2026-11-01",owner_id:owner,
  cost_category:"video_generation",source_type:"provider_invoice",currency:"USD",
  amount_minor:340,entry_type:"expense",source_reference:"runway:inv-001:line-001",
  created_at:"2026-11-24T12:05:00.000Z"};
 const link={id:"99999999-9999-4999-8999-999999999999",reconciliation_event_id:reconId,
  usage_event_id:usageId,service_cost_event_id:costId,owner_id:owner,project_id:project,
  job_id:job,provider:"runway",model:"seedance-2.5",operation:"video",currency:"USD",
  amount_minor:340,invoice_import_id:invoiceId,invoice_line_id:lineId};
 return {
  jobId:job,now,usageEvents:[usage],attributionLinks:[link],invoiceImports:[invoice],
  invoiceLines:[line],reconciliationEvents:[recon],serviceCostEvents:[cost],...overrides
 };
}

test("verifies exact immutable invoice-to-usage-to-service-ledger chain for a persisted job",()=>{
 const result=buildJobCostSourceEvidenceReadiness(fixture());
 assert.equal(result.status,"partial_historical_actuals");
 assert.equal(result.providerCompute.status,"verified_historical_actual");
 assert.equal(result.providerCompute.currency,"USD");
 assert.equal(result.providerCompute.amountMinor,340);
 assert.equal(result.providerCompute.amountMicros,3_400_000);
 assert.equal(result.verifiedProviderInvoiceLinks,1);
 assert.equal(result.fullyLoadedReady,false);
 assert.equal(result.dispatchEvidenceEligible,false);
 assert.equal(result.missingCategories.length,8);
});

test("does not assume a failed provider job incurred zero cost",()=>{
 const result=buildJobCostSourceEvidenceReadiness(fixture());
 assert.equal(result.providerCompute.amountMinor,340);
 assert.equal(result.sourceExceptions.length,0);
});

test("rejects an incomplete invoice attribution chain",()=>{
 const input=fixture({serviceCostEvents:[]});
 const result=buildJobCostSourceEvidenceReadiness(input);
 assert.equal(result.providerCompute.status,"missing_job_level_evidence");
 assert.ok(result.sourceExceptions.length>0);
});

test("accepts immutable pending import headers only when every line has a matched reconciliation event",()=>{
 const valid=buildJobCostSourceEvidenceReadiness(fixture());
 assert.equal(valid.providerCompute.status,"verified_historical_actual");
});

test("rejects an invoice that is not fully reconciled to every imported line",()=>{
 const input=fixture({invoiceImports:[{...fixture().invoiceImports[0],reconciliation_status:"variance"}]});
 const result=buildJobCostSourceEvidenceReadiness(input);
 assert.notEqual(result.providerCompute.status,"verified_historical_actual");
});

test("rejects invoice header totals that do not equal all imported invoice lines",()=>{
 const input=fixture({invoiceImports:[{...fixture().invoiceImports[0],total_minor:999}]});
 const result=buildJobCostSourceEvidenceReadiness(input);
 assert.notEqual(result.providerCompute.status,"verified_historical_actual");
});

test("rejects ambiguous or mismatched reconciliation events",()=>{
 const input=fixture({reconciliationEvents:[{...fixture().reconciliationEvents[0],candidate_count:2}]});
 const result=buildJobCostSourceEvidenceReadiness(input);
 assert.notEqual(result.providerCompute.status,"verified_historical_actual");
});

test("rejects cost records whose owner, category, source or amount differs",()=>{
 const base=fixture();
 const wrongOwner=buildJobCostSourceEvidenceReadiness({...base,serviceCostEvents:[{...base.serviceCostEvents[0],owner_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}]});
 assert.notEqual(wrongOwner.providerCompute.status,"verified_historical_actual");
 const wrongCategory=buildJobCostSourceEvidenceReadiness({...base,serviceCostEvents:[{...base.serviceCostEvents[0],cost_category:"storage"}]});
 assert.notEqual(wrongCategory.providerCompute.status,"verified_historical_actual");
 const wrongAmount=buildJobCostSourceEvidenceReadiness({...base,serviceCostEvents:[{...base.serviceCostEvents[0],amount_minor:341}]});
 assert.notEqual(wrongAmount.providerCompute.status,"verified_historical_actual");
});

test("requires every provider-reported usage event to have one invoice attribution",()=>{
 const base=fixture();
 const extra={...base.usageEvents[0],id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
 const result=buildJobCostSourceEvidenceReadiness({...base,usageEvents:[...base.usageEvents,extra]});
 assert.notEqual(result.providerCompute.status,"verified_historical_actual");
});

test("rejects duplicate attribution of one source event",()=>{
 const base=fixture();
 const duplicate={...base.attributionLinks[0],id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"};
 const result=buildJobCostSourceEvidenceReadiness({...base,attributionLinks:[...base.attributionLinks,duplicate]});
 assert.notEqual(result.providerCompute.status,"verified_historical_actual");
});

test("does not combine different currencies or invent foreign exchange",()=>{
 const base=fixture();
 const u2="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",i2="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 const l2="cccccccc-cccc-4ccc-8ccc-cccccccccccc",r2="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
 const c2="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",a2="ffffffff-ffff-4fff-8fff-ffffffffffff";
 const secondUsage={...base.usageEvents[0],id:u2,currency:"EUR",cost_minor:100,invoice_line_reference:"line-002"};
 const secondImport={...base.invoiceImports[0],id:i2,currency:"EUR",total_minor:100,
  source_fingerprint:"b".repeat(64)};
 const secondLine={...base.invoiceLines[0],id:l2,import_id:i2,provider_line_reference:"line-002",
  currency:"EUR",amount_minor:100};
 const secondRecon={...base.reconciliationEvents[0],id:r2,invoice_import_id:i2,invoice_line_id:l2,
  usage_event_id:u2,currency:"EUR",expected_amount_minor:100,observed_amount_minor:100};
 const secondCost={...base.serviceCostEvents[0],id:c2,currency:"EUR",amount_minor:100};
 const secondLink={...base.attributionLinks[0],id:a2,usage_event_id:u2,invoice_import_id:i2,
  invoice_line_id:l2,reconciliation_event_id:r2,service_cost_event_id:c2,currency:"EUR",amount_minor:100};
 const result=buildJobCostSourceEvidenceReadiness({...base,
  usageEvents:[...base.usageEvents,secondUsage],attributionLinks:[...base.attributionLinks,secondLink],
  invoiceImports:[...base.invoiceImports,secondImport],invoiceLines:[...base.invoiceLines,secondLine],
  reconciliationEvents:[...base.reconciliationEvents,secondRecon],serviceCostEvents:[...base.serviceCostEvents,secondCost]});
 assert.notEqual(result.providerCompute.status,"verified_historical_actual");
 assert.ok(result.sourceExceptions.some(x=>x.includes("multiple currencies")));
});

test("shared and monthly ledgers are not silently allocated to one job",()=>{
 const result=buildJobCostSourceEvidenceReadiness(fixture());
 for(const category of ["storage","egress","payment_processing","moderation","retry_allowance","tax","refund_reserve","support"]){
  assert.equal(result.categories.find(x=>x.category===category).status,"missing_job_level_evidence");
 }
});

test("requires a persisted job UUID and bounded source collections",()=>{
 assert.equal(buildJobCostSourceEvidenceReadiness({jobId:"not-a-job"}).code,"JOB_COST_EVIDENCE_JOB_ID_INVALID");
 assert.equal(buildJobCostSourceEvidenceReadiness(fixture({usageEvents:Array(5001).fill({})})).code,"JOB_COST_EVIDENCE_INPUT_INVALID");
});
