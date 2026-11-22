import {createHash} from "node:crypto";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const integer=(value,label,{min=0,max=9_000_000_000_000}={})=>{
 if(!Number.isSafeInteger(value)||value<min||value>max)fail("SUBSCRIPTION_ALLOWANCE_APPROVAL_INPUT_INVALID",label+" must be a bounded integer.");
 return value;
};
const text=(value,label,max=240)=>{
 if(typeof value!=="string"||!value.trim()||value.trim().length>max)fail("SUBSCRIPTION_ALLOWANCE_APPROVAL_INPUT_INVALID",label+" is required.");
 return value.trim();
};
const canonical=value=>JSON.stringify(value,Object.keys(value).sort());
const digest=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Creates a deterministic approval packet for one exact plan allowance.
 * The packet is evidence only: it never grants credits or publishes a plan.
 */
export function createSubscriptionAllowanceApprovalPacket({
 plan,planVersion,allowanceCredits,providerCostPerCustomerCreditMinor,
 costEvidence,targetGrossMarginBps,paymentFeeBps,refundReserveBps=0,
 fixedPaymentFeeMinor=0,supportReserveMinor=0,infrastructureReserveMinor=0
}={}){
 if(!plan||typeof plan!=="object"||Array.isArray(plan))fail("SUBSCRIPTION_ALLOWANCE_APPROVAL_INPUT_INVALID","A plan is required.");
 const planCode=text(plan.planCode,"plan code",64).toLowerCase();
 const name=text(plan.name,"plan name",100);
 const currency=text(plan.currency,"plan currency",3).toUpperCase();
 if(currency!=="USD")fail("SUBSCRIPTION_ALLOWANCE_APPROVAL_INPUT_INVALID","Only USD proposals are supported by this approval packet.");
 const version=integer(planVersion,"plan version",{min:1,max:1_000_000});
 const monthlyPriceMinor=integer(plan.monthlyPriceMinor,"monthly price",{min:1});
 const credits=integer(allowanceCredits,"included credits",{min:1,max:1_000_000_000});
 const cost=integer(providerCostPerCustomerCreditMinor,"measured provider cost per platform credit",{min:1});
 const margin=integer(targetGrossMarginBps,"target gross margin",{min:0,max:9500});
 const payment=integer(paymentFeeBps,"payment fee",{min:0,max:9999});
 const refund=integer(refundReserveBps,"refund reserve",{min:0,max:9999});
 const fixed=integer(fixedPaymentFeeMinor,"fixed payment fee");
 const support=integer(supportReserveMinor,"support reserve");
 const infrastructure=integer(infrastructureReserveMinor,"infrastructure reserve");
 if(payment+refund>=10000)fail("SUBSCRIPTION_ALLOWANCE_APPROVAL_INPUT_INVALID","Payment and refund reserves must total less than 100%.");
 if(!costEvidence||typeof costEvidence!=="object"||Array.isArray(costEvidence)||
    costEvidence.status!=="verified_measured"||costEvidence.approved!==false||
    !Number.isSafeInteger(costEvidence.sampleJobs)||costEvidence.sampleJobs<5||
    typeof costEvidence.source!=="string"||!costEvidence.source.trim()||
    typeof costEvidence.rateCardVersion!=="string"||!costEvidence.rateCardVersion.trim())
  fail("SUBSCRIPTION_ALLOWANCE_COST_EVIDENCE_INVALID","At least five jobs of verified, unapproved invoice-backed cost evidence are required.");
 const start=Date.parse(costEvidence.periodStart),end=Date.parse(costEvidence.periodEnd);
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)
  fail("SUBSCRIPTION_ALLOWANCE_COST_EVIDENCE_INVALID","Cost evidence must contain a valid increasing reporting period.");
 const proposal=Object.freeze({
  planCode,name,planVersion:version,currency,monthlyPriceMinor,includedCredits:credits,
  providerCostPerCustomerCreditMinor:cost,
  costEvidence:Object.freeze({
   status:"verified_measured",approved:false,source:text(costEvidence.source,"cost evidence source"),
   rateCardVersion:text(costEvidence.rateCardVersion,"cost evidence version",100),
   sampleJobs:costEvidence.sampleJobs,periodStart:new Date(start).toISOString(),
   periodEnd:new Date(end).toISOString()
  }),
  assumptions:Object.freeze({
   targetGrossMarginBps:margin,paymentFeeBps:payment,refundReserveBps:refund,
   fixedPaymentFeeMinor:fixed,supportReserveMinor:support,infrastructureReserveMinor:infrastructure
  })
 });
 const proposalHash=digest(proposal);
 return Object.freeze({
  proposal,proposalHash,status:"awaiting_dual_approval",publishable:false,
  requiredApprovals:Object.freeze([
   Object.freeze({stage:"finance",role:"billing_admin"}),
   Object.freeze({stage:"product",role:"platform_admin"})
  ]),
  invalidationRule:"Any change to plan version, price, allowance, measured cost evidence or financial assumptions creates a different proposal hash and requires fresh approvals."
 });
}

/**
 * Evaluate trusted approval rows loaded server-side. Browser-supplied roles or
 * approvals must never be passed to this function.
 */
export function evaluateSubscriptionAllowanceApprovals(packet,approvals=[]){
 if(!packet||typeof packet!=="object"||!packet.proposal||typeof packet.proposalHash!=="string"||
    !Array.isArray(approvals))
  fail("SUBSCRIPTION_ALLOWANCE_APPROVAL_INPUT_INVALID","A proposal packet and server-loaded approval records are required.");
 const expectedHash=digest(packet.proposal);
 if(expectedHash!==packet.proposalHash)return Object.freeze({status:"stale",eligibleToPublish:false,reason:"proposal_hash_mismatch"});
 const required={finance:"billing_admin",product:"platform_admin"};
 const matched={};
 const seenActors=new Set();
 for(const approval of approvals){
  if(!approval||typeof approval!=="object"||approval.proposalHash!==expectedHash||
     !Object.hasOwn(required,approval.stage))continue;
  const actorId=String(approval.actorId||"");
  if(!UUID.test(actorId)||approval.role!==required[approval.stage]||
     !["approved","rejected"].includes(approval.status))continue;
  if(matched[approval.stage])continue;
  matched[approval.stage]=approval;
 }
 const decisions=Object.values(matched);
 for(const item of decisions){
  const actor=String(item.actorId).toLowerCase();
  if(seenActors.has(actor))return Object.freeze({status:"separation_of_duties_failed",eligibleToPublish:false,reason:"approvers_must_be_distinct"});
  seenActors.add(actor);
 }
 if(decisions.some(item=>item.status==="rejected"))
  return Object.freeze({status:"rejected",eligibleToPublish:false,reason:"approval_rejected"});
 if(!matched.finance||!matched.product)
  return Object.freeze({status:"awaiting_dual_approval",eligibleToPublish:false,reason:"both_finance_and_product_approvals_required"});
 return Object.freeze({
  status:"approved",eligibleToPublish:true,proposalHash:expectedHash,
  approvals:Object.freeze([
   Object.freeze({stage:"finance",actorId:matched.finance.actorId}),
   Object.freeze({stage:"product",actorId:matched.product.actorId})
  ]),
  publishable:false,
  nextStep:"A separate, audited publication command must revalidate the exact proposal hash and current plan version before changing customer entitlements."
 });
}
