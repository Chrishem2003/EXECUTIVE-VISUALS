import { createHash } from "node:crypto";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY=/^[A-Z]{3}$/;
const RESOURCE_CATEGORY=Object.freeze({storage_gb_day:"storage",egress_gb:"egress"});
const clean=value=>String(value??"").trim();
const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail=(code,reason)=>Object.freeze({ready:false,code,reason});
const integerAmount=value=>value===null||value===undefined||value===""?null:Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null;
const validDate=value=>typeof value==="string"&&Number.isFinite(Date.parse(value));

/**
 * Historical, job-scoped storage/egress actual-cost evidence.
 * No shared allocation, future forecasting, FX, ledger writes or dispatch eligibility.
 */
export function buildJobResourceCostEvidence({jobId,usageEvents=[],rateCards=[]}={}) {
  const id=clean(jobId);
  if(!UUID.test(id))return fail("JOB_RESOURCE_EVIDENCE_JOB_ID_INVALID","A persisted job UUID is required.");
  if(!Array.isArray(usageEvents)||!Array.isArray(rateCards)||usageEvents.length>5000||rateCards.length>2000)
    return fail("JOB_RESOURCE_EVIDENCE_INPUT_INVALID","Usage and rate-card inputs must be bounded arrays.");
  if(usageEvents.some(row=>!clean(row?.id))||new Set(usageEvents.map(row=>clean(row.id))).size!==usageEvents.length)
    return fail("JOB_RESOURCE_EVIDENCE_DUPLICATE_USAGE_ID","Resource usage rows contain a missing or duplicate immutable ID.");
  if(rateCards.some(row=>!clean(row?.id))||new Set(rateCards.map(row=>clean(row.id))).size!==rateCards.length)
    return fail("JOB_RESOURCE_EVIDENCE_DUPLICATE_RATE_ID","Resource rate cards contain a missing or duplicate ID.");

  const jobEvents=usageEvents.filter(row=>clean(row.job_id)===id);
  const categories=["storage","egress"].map(category=>({category,events:[],amountMinor:0,currency:null,issues:[]}));
  const byCategory=new Map(categories.map(row=>[row.category,row]));
  for(const event of jobEvents) {
    const category=RESOURCE_CATEGORY[clean(event.resource_type)];
    if(!category)continue;
    const target=byCategory.get(category);
    const occurred=clean(event.occurred_at);
    const quantity=Number(event.quantity);
    const unit=clean(event.unit);
    const currency=clean(event.currency).toUpperCase();
    if(!validDate(occurred)||!Number.isFinite(quantity)||quantity<=0||!CURRENCY.test(currency)) {
      target.issues.push("A job resource event has invalid time, quantity or currency.");continue;
    }
    const evidence=event.evidence&&typeof event.evidence==="object"&&!Array.isArray(event.evidence)?event.evidence:{};
    if(!["worker_instrumentation","cloud_provider_meter"].includes(clean(evidence.source))) {
      target.issues.push("A resource event lacks accepted machine-measured provenance.");continue;
    }
    const candidates=rateCards.filter(rate=>
      clean(rate.provider)===clean(event.provider)&&
      clean(rate.resource_type)===clean(event.resource_type)&&
      clean(rate.unit)===unit&&clean(rate.currency).toUpperCase()===currency&&
      validDate(clean(rate.effective_from))&&Date.parse(rate.effective_from)<=Date.parse(occurred)&&
      (!rate.effective_to||(!validDate(clean(rate.effective_to))?false:Date.parse(rate.effective_to)>=Date.parse(occurred)))&&
      Number.isFinite(Number(rate.rate_minor_per_unit))&&Number(rate.rate_minor_per_unit)>0&&
      ["provider_invoice","cloud_contract","admin_verified"].includes(clean(rate.source_type))&&
      clean(rate.source_reference).length>=3
    );
    if(candidates.length!==1) {
      target.issues.push(candidates.length===0
        ?"No effective, evidence-backed resource rate card matches this job event."
        :"Multiple effective resource rate cards match this job event; the cost is ambiguous.");
      continue;
    }
    const rate=candidates[0];
    const costMinor=Math.ceil(quantity*Number(rate.rate_minor_per_unit));
    if(!Number.isSafeInteger(costMinor)||costMinor<=0) {
      target.issues.push("The measured quantity and rate do not produce a safe positive minor-unit cost.");continue;
    }
    if(target.currency&&target.currency!==currency) {
      target.issues.push("A job resource category contains multiple currencies; no FX conversion is inferred.");continue;
    }
    target.currency=currency;
    target.amountMinor+=costMinor;
    if(!Number.isSafeInteger(target.amountMinor)) {
      target.issues.push("The accumulated resource cost exceeds safe integer precision.");continue;
    }
    target.events.push({usageEventId:clean(event.id),rateCardId:clean(rate.id),resourceType:clean(event.resource_type),
      provider:clean(event.provider),unit,quantity,currency,rateMinorPerUnit:Number(rate.rate_minor_per_unit),
      amountMinor:costMinor,occurredAt:occurred});
  }

  const results=categories.map(row=>{
    const complete=row.events.length>0&&row.issues.length===0;
    if(!complete)return {category:row.category,status:"missing_job_level_evidence",
      verifiedEventCount:row.events.length,sourceExceptions:[...new Set(row.issues)],
      reason:row.issues.length?row.issues[0]:"No measured job-level resource events were found."};
    const records=[...row.events].sort((a,b)=>a.usageEventId.localeCompare(b.usageEventId));
    return {category:row.category,status:"verified_historical_actual",currency:row.currency,
      amountMinor:row.amountMinor,verifiedEventCount:records.length,
      sourceRecordId:"job-resource-cost-bundle:"+id+":"+row.category,
      sourceDigest:digest({version:"job-resource-cost-evidence-v1",jobId:id,category:row.category,records}),
      records};
  });
  const ready=results.every(row=>row.status==="verified_historical_actual");
  return Object.freeze({jobId:id,status:ready?"verified_storage_egress_historical_actuals":"partial_or_missing_resource_actuals",
    categories:Object.freeze(results),fullyLoadedReady:false,dispatchEvidenceEligible:false,
    limitations:Object.freeze([
      "These are historical actuals only; they are not a future per-shot forecast or dispatch quote.",
      "Only machine-measured job-level storage_gb_day and egress_gb events are considered.",
      "Rates must match provider, resource type, unit, currency and event effective date exactly.",
      "Ambiguous, unpriced, manually entered or unsupported events remain excluded and block category readiness.",
      "No shared monthly cost allocation, FX conversion, ledger write, credit settlement or provider dispatch occurs."
    ])});
}
