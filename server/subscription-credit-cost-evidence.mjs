const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_MINOR=9_000_000_000_000;
const MIN_SAMPLE_JOBS=5;

/**
 * Derive a conservative blended USD-cent cost per platform credit from
 * complete jobs with immutable invoice attribution and settled credit usage.
 * Estimates, provider-reported amounts, FX and partial jobs are excluded.
 */
export function deriveInvoiceBackedCreditCostEvidence({
 periodMonth,usageEvents=[],invoiceAttributions=[],creditReservations=[],sampleComplete=true
}={}){
 if(!/^\d{4}-\d{2}-01$/.test(String(periodMonth||""))||
    !Number.isFinite(Date.parse(periodMonth+"T00:00:00Z"))||
    new Date(periodMonth+"T00:00:00Z").toISOString().slice(0,10)!==periodMonth)
  throw Object.assign(new Error("A valid first day of a reporting month is required."),{code:"SUBSCRIPTION_COST_EVIDENCE_PERIOD_INVALID"});
 const periodStart=periodMonth+"T00:00:00.000Z";
 const monthDate=new Date(periodMonth+"T00:00:00.000Z");
 monthDate.setUTCMonth(monthDate.getUTCMonth()+1);
 const periodEnd=monthDate.toISOString();
 if(!sampleComplete)return Object.freeze({status:"sample_incomplete",periodMonth,periodStart,periodEnd,sampleJobs:0,sampleCredits:null,totalProviderCostMinor:null,providerCostPerCustomerCreditMinor:null,excludedJobs:null,minimumSampleJobs:MIN_SAMPLE_JOBS});
 const events=Array.isArray(usageEvents)?usageEvents:[];
 const attributions=Array.isArray(invoiceAttributions)?invoiceAttributions:[];
 const reservations=Array.isArray(creditReservations)?creditReservations:[];
 const eventIds=new Set();
 const byJob=new Map();
 for(const event of events){
  const id=String(event?.id||""),jobId=String(event?.job_id||"");
  if(!UUID.test(id)||!UUID.test(jobId)||eventIds.has(id))continue;
  eventIds.add(id);
  if(!byJob.has(jobId))byJob.set(jobId,[]);
  byJob.get(jobId).push(event);
 }
 const linksByEvent=new Map();
 for(const link of attributions){
  const id=String(link?.usage_event_id||"");
  if(!eventIds.has(id))continue;
  if(!linksByEvent.has(id))linksByEvent.set(id,[]);
  linksByEvent.get(id).push(link);
 }
 const reservationsByJob=new Map();
 for(const reservation of reservations){
  const jobId=String(reservation?.job_id||"");
  if(!byJob.has(jobId))continue;
  if(!reservationsByJob.has(jobId))reservationsByJob.set(jobId,[]);
  reservationsByJob.get(jobId).push(reservation);
 }
 let totalCost=0n,totalCredits=0n,sampleJobs=0,excludedJobs=0;
 for(const [jobId,jobEvents] of byJob){
  if(jobEvents.some(event=>event.status!=="succeeded")){excludedJobs++;continue;}
  const jobReservations=reservationsByJob.get(jobId)||[];
  if(jobReservations.length!==1){excludedJobs++;continue;}
  const reservation=jobReservations[0];
  const credits=Number(reservation.actual_credits);
  if(reservation.state!=="settled"||!Number.isSafeInteger(credits)||credits<=0){excludedJobs++;continue;}
  let jobCost=0n,valid=true;
  for(const event of jobEvents){
   const links=linksByEvent.get(String(event.id))||[];
   if(links.length!==1){valid=false;break;}
   const link=links[0],amount=Number(link.amount_minor);
   if(String(link.currency||"").toUpperCase()!=="USD"||
      !Number.isSafeInteger(amount)||amount<=0||
      !UUID.test(String(link.invoice_import_id||""))||
      !UUID.test(String(link.invoice_line_id||""))){valid=false;break;}
   jobCost+=BigInt(amount);
  }
  if(!valid){excludedJobs++;continue;}
  totalCost+=jobCost;totalCredits+=BigInt(credits);sampleJobs++;
 }
 const safeCost=totalCost<=BigInt(MAX_MINOR)&&totalCredits<=BigInt(Number.MAX_SAFE_INTEGER);
 const enough=sampleJobs>=MIN_SAMPLE_JOBS&&totalCost>0n&&totalCredits>0n&&safeCost;
 const perCredit=enough?Number((totalCost+totalCredits-1n)/totalCredits):null;
 const sampleCredits=sampleJobs&&safeCost?Number(totalCredits):null;
 const totalProviderCostMinor=sampleJobs&&safeCost?Number(totalCost):null;
 const evidence=enough?Object.freeze({
  status:"verified_measured",approved:false,
  source:"immutable invoice attribution links + settled job credit reservations",
  rateCardVersion:"invoice-attribution-derived-v1",
  sampleJobs,periodStart,periodEnd
 }):null;
 return Object.freeze({
  status:!byJob.size?"no_usage_jobs":!sampleJobs?"no_verified_jobs":!safeCost?"sample_out_of_range":sampleJobs<MIN_SAMPLE_JOBS?"insufficient_sample":!totalCost?"zero_invoice_cost":"verified_measured",
  periodMonth,periodStart,periodEnd,sampleJobs,sampleCredits,totalProviderCostMinor,
  providerCostPerCustomerCreditMinor:enough?perCredit:null,excludedJobs,
  minimumSampleJobs:MIN_SAMPLE_JOBS,evidence
 });
}
