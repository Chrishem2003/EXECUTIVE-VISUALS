const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIN_SAMPLE_JOBS=5;
const MAX_MINOR=9_000_000_000_000;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const normalized=value=>String(value??"").trim().toLowerCase();

/**
 * Derive model/operation actual costs only from immutable, posted invoice
 * attribution links. A group is verified only when every usage event in the
 * complete period sample has one exact, same-provider/model/operation/currency
 * invoice link and at least five distinct jobs are represented.
 */
export function deriveInvoiceBackedModelCostEvidence({periodMonth,usageEvents=[],invoiceAttributions=[],sampleComplete=true}={}){
 if(!/^\\d{4}-\\d{2}-01$/.test(String(periodMonth||""))||
    !Number.isFinite(Date.parse(periodMonth+"T00:00:00Z"))||
    new Date(periodMonth+"T00:00:00Z").toISOString().slice(0,10)!==periodMonth)
  fail("MODEL_COST_EVIDENCE_PERIOD_INVALID","A valid first day of a reporting month is required.");
 const monthDate=new Date(periodMonth+"T00:00:00Z");
 monthDate.setUTCMonth(monthDate.getUTCMonth()+1);
 const periodStart=periodMonth+"T00:00:00.000Z",periodEnd=monthDate.toISOString();
 const events=Array.isArray(usageEvents)?usageEvents:[];
 const links=Array.isArray(invoiceAttributions)?invoiceAttributions:[];
 const eventById=new Map();
 for(const event of events){
  const id=String(event?.id||"");
  if(!UUID.test(id)||eventById.has(id))continue;
  if(String(event.period_month||"")!==periodMonth)continue;
  const provider=normalized(event.provider);
  const model=normalized(event.response_model||event.requested_model);
  const operation=normalized(event.operation);
  const currency=String(event.currency||"").toUpperCase();
  if(!provider||!model||!operation||!/^[A-Z]{3}$/.test(currency))continue;
  const key=[provider,model,operation,currency].join("\\u001f");
  if(!eventById.has(id))eventById.set(id,{id,jobId:UUID.test(String(event.job_id||""))?String(event.job_id):null,provider,model,operation,currency,key});
 }
 const groups=new Map();
 for(const event of eventById.values()){
  if(!groups.has(event.key))groups.set(event.key,{provider:event.provider,model:event.model,operation:event.operation,currency:event.currency,events:[],links:[]});
  groups.get(event.key).events.push(event);
 }
 const linksByEvent=new Map();
 for(const link of links){
  const id=String(link?.usage_event_id||"");
  if(!eventById.has(id))continue;
  if(!linksByEvent.has(id))linksByEvent.set(id,[]);
  linksByEvent.get(id).push(link);
 }
 let verifiedGroups=0,partialGroups=0,insufficientGroups=0,totalVerifiedCost=0;
 const models=[];
 for(const group of groups.values()){
  let total=0n,matched=0,invalid=0;
  const jobs=new Set();
  for(const event of group.events){
   if(event.jobId)jobs.add(event.jobId);
   const rows=linksByEvent.get(event.id)||[];
   if(rows.length!==1){invalid++;continue;}
   const link=rows[0],amount=Number(link.amount_minor);
   const exact=normalized(link.provider)===group.provider&&normalized(link.model)===group.model&&
    normalized(link.operation)===group.operation&&String(link.currency||"").toUpperCase()===group.currency&&
    UUID.test(String(link.invoice_import_id||""))&&UUID.test(String(link.invoice_line_id||""))&&
    UUID.test(String(link.reconciliation_event_id||""))&&UUID.test(String(link.service_cost_event_id||""))&&
    Number.isSafeInteger(amount)&&amount>0;
   if(!exact){invalid++;continue;}
   total+=BigInt(amount);matched++;
  }
  const safe=total<=BigInt(MAX_MINOR);
  const coverage=group.events.length?Number((matched/group.events.length).toFixed(6)):0;
  const complete=sampleComplete&&invalid===0&&matched===group.events.length&&safe;
  const enough=complete&&jobs.size>=MIN_SAMPLE_JOBS;
  const status=!sampleComplete?"sample_incomplete":!safe?"sample_out_of_range":invalid?"partial_invoice_coverage":!enough?"insufficient_sample":"verified_measured";
  if(status==="verified_measured"){verifiedGroups++;totalVerifiedCost+=Number(total);}
  else if(status==="partial_invoice_coverage")partialGroups++;
  else insufficientGroups++;
  models.push(Object.freeze({
   provider:group.provider,model:group.model,operation:group.operation,currency:group.currency,
   status,sampleEvents:group.events.length,sampleJobs:jobs.size,matchedInvoiceEvents:matched,
   invoiceCoverage:coverage,totalProviderCostMinor:enough?Number(total):null,
   averageCostPerUsageEventMinor:enough?Number((total+BigInt(group.events.length)-1n)/BigInt(group.events.length)):null,
   minimumSampleJobs:MIN_SAMPLE_JOBS,periodMonth
  }));
 }
 models.sort((a,b)=>a.provider.localeCompare(b.provider)||a.model.localeCompare(b.model)||a.operation.localeCompare(b.operation)||a.currency.localeCompare(b.currency));
 const status=!sampleComplete?"sample_incomplete":!models.length?"no_usage_events":verifiedGroups===models.length?"verified_measured":verifiedGroups?"partially_measured":"insufficient_or_unmatched_evidence";
 return Object.freeze({
  status,periodMonth,periodStart,periodEnd,sampleComplete,
  modelGroups:models.length,verifiedModelGroups:verifiedGroups,partialModelGroups:partialGroups,
  insufficientModelGroups:insufficientGroups,models:Object.freeze(models),
  limitations:Object.freeze([
   "Actuals come only from immutable invoice-to-usage attribution links created after exact provider invoice reconciliation and posting.",
   "Provider, response/request model, operation and currency must match exactly; no fuzzy matching or foreign-exchange conversion is performed.",
   "Each model/operation group requires complete period coverage and at least five distinct jobs; partial groups show coverage but no total actual cost.",
   "This is historical observed cost, not a guaranteed future rate or customer credit price.",
   "Shared infrastructure, taxes, refunds, chargebacks and costs not attributed to a provider usage event are excluded.",
   "The result is read-only and does not post invoices, write ledgers, change plans or grant credits."
  ])
 });
}
