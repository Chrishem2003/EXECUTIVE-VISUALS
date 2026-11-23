import test from "node:test";
import assert from "node:assert/strict";
import {convertProviderCostWithApprovedFx,selectApprovedSettlementFxEvidence} from "../approved-fx-rate-conversion.mjs";

const approved={evidence_id:"fx-001",source_currency:"USD",target_currency:"UGX",period_month:"2026-11-01",rate_scaled:421690000000,rate_scale:100000000,
 effective_date:"2026-11-23",source_type:"processor_settlement",purpose:"settlement_cost",source_reference:"settlement-2026-11-23",
 decision:"approved",decision_reason:"Matched to processor settlement statement",decision_created_at:"2026-11-23T12:00:00Z"};
test("converts USD cents to UGX whole shillings using approved settlement evidence and conservative rounding",()=>{
 const result=convertProviderCostWithApprovedFx({amountMinor:100,sourceCurrency:"USD",targetCurrency:"UGX",periodMonth:"2026-11-01",fxEvidence:approved});
 assert.equal(result.status,"converted_with_approved_settlement_evidence");
 assert.equal(result.amountMinor,4217);
 assert.equal(result.rateScaled,421690000000);
 assert.equal(result.rounding,"ceil_to_target_minor_unit");
});
test("rejects Bank of Uganda/URA reference rates for settlement-cost conversion",()=>{
 for(const sourceType of ["official_reference","tax_reference","other"]){
  const result=convertProviderCostWithApprovedFx({amountMinor:100,sourceCurrency:"USD",targetCurrency:"UGX",periodMonth:"2026-11-01",fxEvidence:{...approved,source_type:sourceType}});
  assert.equal(result.status,"blocked_fx_evidence");
  assert.equal(result.amountMinor,null);
 }
});
test("blocks pending, rejected, revoked, wrong-currency and wrong-purpose evidence",()=>{
 for(const patch of [{decision:"pending"},{decision:"rejected"},{decision:"revoked"},{target_currency:"KES"},{purpose:"tax_reporting"}]){
  const result=convertProviderCostWithApprovedFx({amountMinor:100,sourceCurrency:"USD",targetCurrency:"UGX",periodMonth:"2026-11-01",fxEvidence:{...approved,...patch}});
  assert.equal(result.status,"blocked_fx_evidence");
 }
});
test("blocks FX evidence assigned to a different invoice reporting period",()=>{
 const result=convertProviderCostWithApprovedFx({amountMinor:100,sourceCurrency:"USD",targetCurrency:"UGX",periodMonth:"2026-11-01",fxEvidence:{...approved,period_month:"2026-12-01"}});
 assert.equal(result.status,"blocked_fx_evidence");
});
test("selects the latest approved settlement evidence for the exact pair and period",()=>{
 const older={...approved,evidence_id:"fx-old",effective_date:"2026-11-20"};
 const reference={...approved,evidence_id:"fx-reference",source_type:"official_reference",effective_date:"2026-11-24"};
 const newer={...approved,evidence_id:"fx-new",effective_date:"2026-11-24"};
 const result=selectApprovedSettlementFxEvidence([older,reference,newer],{sourceCurrency:"USD",targetCurrency:"UGX",periodMonth:"2026-11-01"});
 assert.equal(result.evidence_id,"fx-new");
});
test("does not invent a conversion when no approved evidence exists",()=>{
 const result=convertProviderCostWithApprovedFx({amountMinor:100,sourceCurrency:"USD",targetCurrency:"UGX",periodMonth:"2026-11-01",fxEvidence:null});
 assert.equal(result.status,"blocked_fx_evidence");
 assert.equal(result.amountMinor,null);
});
test("rejects malformed or unsafe amounts and unsupported currency pairs",()=>{
 assert.throws(()=>convertProviderCostWithApprovedFx({amountMinor:-1,sourceCurrency:"USD",targetCurrency:"UGX",periodMonth:"2026-11-01",fxEvidence:approved}),{code:"FX_CONVERSION_AMOUNT_INVALID"});
 assert.throws(()=>convertProviderCostWithApprovedFx({amountMinor:1,sourceCurrency:"ABC",targetCurrency:"UGX",periodMonth:"2026-11-01",fxEvidence:approved}),{code:"FX_CONVERSION_CURRENCY_UNSUPPORTED"});
});
