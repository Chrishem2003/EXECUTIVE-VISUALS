import { evaluatePlatformMarginFloorForShots } from "./platform-margin-policy.mjs";

const fail=(code,reason)=>Object.freeze({readyForDispatch:false,code,reason});

/**
 * Connects the owner policy and server-generated customer-price evidence to
 * each exact priced shot. Additional variable costs are deliberately absent
 * until a trusted, fully-loaded cost-model adapter supplies them; the margin
 * evaluator therefore fails closed rather than treating missing costs as zero.
 */
export function evaluatePlatformMarginPreflight({
  policy,
  pricedShots,
  customerPriceEvidencePerShot,
  quoteObservedAt,
  additionalCostEvidenceByShot,
  now=Date.now()
}={}) {
  if(!Array.isArray(pricedShots)||pricedShots.length<1||pricedShots.length>100||
     !Array.isArray(customerPriceEvidencePerShot)||
     customerPriceEvidencePerShot.length!==pricedShots.length) {
    return fail("PLATFORM_MARGIN_SHOT_EVIDENCE_INCOMPLETE",
      "Every priced shot requires its own server-generated customer sale-price evidence.");
  }
  const shots=[];
  for(let index=0;index<pricedShots.length;index++) {
    const priced=pricedShots[index],customer=customerPriceEvidencePerShot[index];
    const shotId=String(priced?.shotId||priced?.id||"");
    if(!shotId||String(customer?.shotId||"")!==shotId) {
      return fail("PLATFORM_MARGIN_SHOT_IDENTITY_MISMATCH",
        "Provider price and customer sale-price evidence must identify the same shot.");
    }
    const providerEstimate={
      available:true,estimated:true,
      provider:String(priced.provider||""),
      model:String(priced.model||""),
      currency:String(priced.currency||""),
      amount:priced.amount,
      pricing:priced.pricing
    };
    const {shotId:ignored,...customerPriceEvidence}=customer;
    shots.push({
      shotId,providerEstimate,customerPriceEvidence,
      additionalCostEvidence:Array.isArray(additionalCostEvidenceByShot)
        ?additionalCostEvidenceByShot[index]||null:null,
      quoteObservedAt
    });
  }
  return evaluatePlatformMarginFloorForShots({policy,shots,now});
}
