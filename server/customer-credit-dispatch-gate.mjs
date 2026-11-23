/**
 * Gate storyboard budget approval on the same verified customer-credit
 * reservation boundary that will be used at queue submission.
 *
 * The only currently approved direct storyboard dispatcher is the isolated
 * Neon staging application runtime. Production cloud dispatch remains closed
 * until its own atomic reservation and usage-settlement readiness is supplied.
 */
export function applyCustomerCreditDispatchGate(preflight,{stagingDispatchReady=false}={}) {
 if(!preflight||typeof preflight!=="object"||Array.isArray(preflight)) {
  throw new Error("A video production preflight result is required.");
 }
 const quote=preflight.pricing?.quote;
 const creditQuote=quote?.customerCreditQuote;
 const perShot=creditQuote?.perShot;
 const total=creditQuote?.totalCredits;
 const shots=preflight.shots;
 const valid=creditQuote?.unit==="customer_credits"&&
  Number.isSafeInteger(total)&&total>0&&total<=100_000_000&&
  Array.isArray(shots)&&shots.length>0&&
  Array.isArray(perShot)&&perShot.length===shots.length&&
  perShot.every((item,index)=>item&&typeof item.shotId==="string"&&item.shotId===String(shots[index]?.id||"")&&
   Number.isSafeInteger(item.credits)&&item.credits>0&&item.credits<=100_000_000)&&
  perShot.reduce((sum,item)=>sum+item.credits,0)===total;
 if(preflight.status!=="ready_for_approval"||preflight.readyForApproval!==true||
    quote?.available!==true||quote?.estimated!==true||!valid) {
  return {
   ...preflight,status:"pricing_unverified",readyForApproval:false,
   customerCreditDispatch:{available:false,backend:null,reservation:"not_reserved",requestsSubmitted:false},
   reason:"Verified provider pricing and a complete customer-credit estimate for every shot are required. No approval, reservation or generation was submitted."
  };
 }
 if(stagingDispatchReady===true) {
  return {
   ...preflight,status:"ready_for_approval",readyForApproval:true,
   customerCreditDispatch:{available:true,backend:"neon-staging",reservation:"atomic_at_submission",settlement:"authoritative_provider_usage",requestsSubmitted:false},
   reason:"Provider pricing and customer credits are verified. You may record the production budget approval; credits will be reserved atomically when the approved production is submitted to the verified staging queue. No credits have been reserved and no provider request has been submitted."
  };
 }
 return {
  ...preflight,status:"customer_credit_settlement_pending",readyForApproval:false,
  customerCreditDispatch:{available:false,backend:"neon-staging",reservation:"not_reserved",requestsSubmitted:false},
  reason:"Provider pricing and customer-credit estimates are available, but approval and generation remain held because the verified staging dispatcher is not enabled. Production cloud dispatch remains closed until its atomic credit-reservation and authoritative usage-settlement controls are verified."
 };
}
