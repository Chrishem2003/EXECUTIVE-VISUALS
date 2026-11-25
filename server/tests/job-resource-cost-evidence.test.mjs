import test from "node:test";
import assert from "node:assert/strict";
import {buildJobResourceCostEvidence} from "../job-resource-cost-evidence.mjs";

const job="11111111-1111-4111-8111-111111111111";
const usage=(id,type,quantity=2)=>({id,job_id:job,provider:"executive-visuals-worker",resource_type:type,
  quantity,unit:type==="storage_gb_day"?"gb_day":"gb",currency:"USD",
  occurred_at:"2026-11-20T12:00:00.000Z",evidence:{source:"cloud_provider_meter"}});
const rate=(id,type,unit,amount=3)=>({id,provider:"executive-visuals-worker",resource_type:type,unit,
  currency:"USD",rate_minor_per_unit:amount,effective_from:"2026-11-01T00:00:00.000Z",
  effective_to:null,source_type:"cloud_contract",source_reference:"contract-rate-2026"});

test("verifies exact job-scoped storage and egress with effective rate cards",()=>{
 const result=buildJobResourceCostEvidence({jobId:job,
  usageEvents:[usage("storage-event","storage_gb_day"),usage("egress-event","egress_gb")],
  rateCards:[rate("storage-rate","storage_gb_day","gb_day"),rate("egress-rate","egress_gb","gb")]});
 assert.equal(result.status,"verified_storage_egress_historical_actuals");
 assert.equal(result.categories[0].amountMinor,6);
 assert.equal(result.categories[1].amountMinor,6);
 assert.equal(result.fullyLoadedReady,false);
 assert.equal(result.dispatchEvidenceEligible,false);
});

test("does not allocate another job's usage",()=>{
 const other={...usage("other-job","storage_gb_day"),job_id:"22222222-2222-4222-8222-222222222222"};
 const result=buildJobResourceCostEvidence({jobId:job,usageEvents:[other],rateCards:[]});
 assert.equal(result.categories[0].status,"missing_job_level_evidence");
});

test("unpriced, stale and ambiguous rates fail closed",()=>{
 const event=usage("storage-event","storage_gb_day");
 const stale={...rate("old-rate","storage_gb_day","gb_day"),effective_to:"2026-11-01T00:00:00.000Z"};
 const missing=buildJobResourceCostEvidence({jobId:job,usageEvents:[event],rateCards:[stale]});
 assert.equal(missing.categories[0].status,"missing_job_level_evidence");
 const ambiguous=buildJobResourceCostEvidence({jobId:job,usageEvents:[event],
  rateCards:[rate("rate-a","storage_gb_day","gb_day"),rate("rate-b","storage_gb_day","gb_day")]});
 assert.match(ambiguous.categories[0].reason,/Multiple effective/);
});

test("rejects duplicate source IDs and unsupported manual evidence",()=>{
 const duplicate=usage("same-id","storage_gb_day");
 assert.equal(buildJobResourceCostEvidence({jobId:job,usageEvents:[duplicate,duplicate]}).code,
  "JOB_RESOURCE_EVIDENCE_DUPLICATE_USAGE_ID");
 const manual={...usage("manual-event","storage_gb_day"),evidence:{source:"admin_api"}};
 const result=buildJobResourceCostEvidence({jobId:job,usageEvents:[manual],
  rateCards:[rate("storage-rate","storage_gb_day","gb_day")]});
 assert.match(result.categories[0].reason,/machine-measured provenance/);
});

test("rejects mixed currencies without FX conversion",()=>{
 const usd=usage("storage-usd","storage_gb_day");
 const eur={...usage("storage-eur","storage_gb_day"),id:"storage-eur",currency:"EUR"};
 const result=buildJobResourceCostEvidence({jobId:job,usageEvents:[usd,eur],rateCards:[
  rate("usd-rate","storage_gb_day","gb_day"),{...rate("eur-rate","storage_gb_day","gb_day"),currency:"EUR"}]});
 assert.equal(result.categories[0].status,"missing_job_level_evidence");
});
