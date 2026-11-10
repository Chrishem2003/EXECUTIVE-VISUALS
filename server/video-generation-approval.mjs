import { createHash } from "node:crypto";

function canonical(value) {
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==="object"){
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
 }
 return value;
}
const micros=value=>Math.round(value*1_000_000);

/**
 * Build an immutable approval snapshot after a fresh server-side preflight.
 * This is an approval record only: it never submits a provider request.
 */
export function buildVideoGenerationApproval({shots,preflight,budget,confirmed}={}) {
 if(confirmed!==true)throw Object.assign(new Error("Explicit generation budget approval is required."),{code:"VIDEO_APPROVAL_CONFIRMATION_REQUIRED"});
 if(!Array.isArray(shots)||shots.length<1||shots.length>12)throw Object.assign(new Error("Approval requires between 1 and 12 shots."),{code:"VIDEO_APPROVAL_INVALID_SHOTS"});
 if(!preflight||preflight.status!=="ready_for_approval"||preflight.readyForApproval!==true||preflight.requestsSubmitted!==false)throw Object.assign(new Error("A fresh successful dry-run preflight is required before approval."),{code:"VIDEO_APPROVAL_PREFLIGHT_REQUIRED"});
 const quote=preflight.pricing?.quote;
 if(!quote||quote.available!==true||quote.estimated!==true||typeof quote.currency!=="string"||!quote.currency.trim()||!Number.isFinite(quote.amount)||quote.amount<0)throw Object.assign(new Error("A current verified production quote is required."),{code:"VIDEO_APPROVAL_PRICE_UNVERIFIED"});
 if(!budget||typeof budget!=="object"||budget.currency!==quote.currency||!Number.isFinite(budget.amount)||budget.amount<0)throw Object.assign(new Error("Budget ceiling must use the quote currency and be a non-negative amount."),{code:"VIDEO_APPROVAL_INVALID_BUDGET"});
 const quoteMicros=micros(quote.amount),ceilingMicros=micros(budget.amount);
 if(!Number.isSafeInteger(quoteMicros)||!Number.isSafeInteger(ceilingMicros))throw Object.assign(new Error("Quote and budget amounts must fit within safe micro-unit precision."),{code:"VIDEO_APPROVAL_INVALID_BUDGET"});
 if(ceilingMicros<quoteMicros)throw Object.assign(new Error("The verified quote exceeds the approved budget ceiling."),{code:"VIDEO_APPROVAL_BUDGET_EXCEEDED"});
 const snapshot=canonical(shots);
 const requestHash=createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
 return Object.freeze({
  requestHash,
  shotCount:shots.length,
  currency:quote.currency,
  quotedAmountMicros:quoteMicros,
  budgetCeilingMicros:ceilingMicros,
  snapshotJson:JSON.stringify({shots:snapshot,quote:canonical(quote)}),
  status:"approved_pending_submission",
  requestsSubmitted:false
 });
}
