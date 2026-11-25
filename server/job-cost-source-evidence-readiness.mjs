import { createHash } from "node:crypto";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/;
const CURRENCY=/^[A-Z]{3}$/;
const CATEGORIES=Object.freeze([
  "compute","storage","egress","payment_processing","moderation",
  "retry_allowance","tax","refund_reserve","support"
]);
const OPERATION_CATEGORY=Object.freeze({
  video:"video_generation",image:"image_generation",render:"render_compute",
  text:"ai_inference",audio:"ai_inference",upscale:"ai_inference",
  embedding:"ai_inference",other:"ai_inference"
});
const fail=(code,reason)=>Object.freeze({ready:false,code,reason});
const clean=value=>String(value??"").trim();
const key=(...parts)=>parts.map(x=>String(x??"").toLowerCase()).join("\u001f");
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const uniqueBy=(rows,field)=>new Map(rows.map(row=>[String(row?.[field]??""),row]));
const isDate=value=>Number.isFinite(Date.parse(value||""));
const amount=value=>Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null;

function currencyMinorToMicros(value,currency){
  const digits=new Intl.NumberFormat("en",{style:"currency",currency}).resolvedOptions().maximumFractionDigits;
  if(!Number.isInteger(digits)||digits<0||digits>6)return null;
  const converted=value*10**(6-digits);
  return Number.isSafeInteger(converted)?converted:null;
}

function array(value){return Array.isArray(value)?value:[];}

/**
 * Reconcile one persisted generation job against the existing immutable
 * invoice -> reconciliation -> usage -> service-cost attribution chain.
 *
 * This is a historical actual-cost evidence reader. It intentionally does
 * not turn monthly/customer-level shared costs into per-job estimates and
 * does not return the Batch 117 dispatch evidence shape.
 */
export function buildJobCostSourceEvidenceReadiness({
  jobId,usageEvents=[],attributionLinks=[],invoiceImports=[],invoiceLines=[],
  reconciliationEvents=[],serviceCostEvents=[],now=Date.now()
}={}){
  const id=clean(jobId);
  if(!UUID.test(id))return fail("JOB_COST_EVIDENCE_JOB_ID_INVALID","A persisted generation job UUID is required.");
  if(!Number.isSafeInteger(now)||now<0)return fail("JOB_COST_EVIDENCE_CLOCK_INVALID","A valid server clock is required.");
  const inputs=[usageEvents,attributionLinks,invoiceImports,invoiceLines,reconciliationEvents,serviceCostEvents];
  if(inputs.some(value=>!Array.isArray(value)||value.length>5000))
    return fail("JOB_COST_EVIDENCE_INPUT_INVALID","Every source collection must be an array containing no more than 5,000 rows.");

  const usages=array(usageEvents).filter(row=>row?.job_id===id);
  const links=array(attributionLinks).filter(row=>row?.job_id===id);
  const importsById=uniqueBy(invoiceImports,"id");
  const linesById=uniqueBy(invoiceLines,"id");
  const reconById=uniqueBy(reconciliationEvents,"id");
  const costsById=uniqueBy(serviceCostEvents,"id");
  const usageById=uniqueBy(usages,"id");
  const linkedUsageIds=new Set(),linkedLineIds=new Set(),linkedServiceIds=new Set(),linkedReconIds=new Set();
  const importLineRows=new Map();
  for(const line of invoiceLines){
    const importId=clean(line?.import_id);
    if(!importLineRows.has(importId))importLineRows.set(importId,[]);
    importLineRows.get(importId).push(line);
  }
  const reconImportRows=new Map();
  for(const row of reconciliationEvents){
    const importId=clean(row?.invoice_import_id);
    if(!reconImportRows.has(importId))reconImportRows.set(importId,[]);
    reconImportRows.get(importId).push(row);
  }

  let totalMinor=0,currency=null,latestEvidenceAt=0;
  const accepted=[];
  const problems=[];
  for(const link of links){
    const usageId=clean(link?.usage_event_id),lineId=clean(link?.invoice_line_id);
    const costId=clean(link?.service_cost_event_id),reconId=clean(link?.reconciliation_event_id);
    if(!UUID.test(usageId)||!UUID.test(lineId)||!UUID.test(costId)||!UUID.test(reconId)){
      problems.push("Attribution link contains an invalid source identifier.");continue;
    }
    if(linkedUsageIds.has(usageId)||linkedLineIds.has(lineId)||linkedServiceIds.has(costId)||linkedReconIds.has(reconId)){
      problems.push("A usage event, invoice line, service-cost event or reconciliation event is attributed more than once.");continue;
    }
    linkedUsageIds.add(usageId);linkedLineIds.add(lineId);linkedServiceIds.add(costId);linkedReconIds.add(reconId);
    const usage=usageById.get(usageId),line=linesById.get(lineId),cost=costsById.get(costId);
    const recon=reconById.get(reconId),invoice=importsById.get(clean(link?.invoice_import_id));
    if(!usage||!line||!cost||!recon||!invoice){problems.push("The invoice attribution chain is incomplete.");continue;}
    const value=amount(link.amount_minor),lineAmount=amount(line.amount_minor),usageAmount=amount(usage.cost_minor),costAmount=amount(cost.amount_minor);
    const curr=clean(link.currency).toUpperCase();
    const operation=clean(usage.operation);
    const expectedCostCategory=OPERATION_CATEGORY[operation];
    const exact=
      UUID.test(clean(invoice.id))&&UUID.test(clean(line.id))&&
      invoice.reconciliation_status==="matched"&&HASH.test(clean(invoice.source_fingerprint))&&
      invoice.provider===usage.provider&&invoice.currency===curr&&line.import_id===invoice.id&&
      line.provider===usage.provider&&line.model===clean(usage.requested_model)&&
      line.currency===curr&&line.match_status==="matched"&&
      line.matched_usage_event_id===usage.id&&line.job_id===id&&
      recon.invoice_import_id===invoice.id&&recon.invoice_line_id===line.id&&
      recon.usage_event_id===usage.id&&recon.match_status==="matched"&&
      Number(recon.candidate_count)===1&&Number(recon.expected_amount_minor)===value&&
      Number(recon.observed_amount_minor)===value&&recon.currency===curr&&
      usage.cost_basis==="provider_reported"&&usage.status==="succeeded"&&
      usage.job_id===id&&usage.provider===link.provider&&
      clean(usage.response_model||usage.requested_model)===clean(link.model)&&
      usage.operation===link.operation&&usage.currency===curr&&
      usage.invoice_line_reference===line.provider_line_reference&&
      usageAmount===value&&lineAmount===value&&value!==null&&value>0&&
      costAmount===value&&cost.currency===curr&&cost.source_type==="provider_invoice"&&
      cost.cost_category===expectedCostCategory&&cost.entry_type==="expense"&&
      cost.owner_id===usage.owner_id&&cost.period_month===usage.period_month&&
      clean(cost.source_reference).length>0&&
      link.owner_id===usage.owner_id&&link.project_id===usage.project_id&&
      link.provider===usage.provider&&clean(link.model)===clean(usage.response_model||usage.requested_model)&&
      link.operation===usage.operation&&link.currency===curr&&
      clean(invoice.imported_at).length>0&&isDate(invoice.imported_at)&&
      clean(cost.created_at).length>0&&isDate(cost.created_at);
    if(!exact){problems.push("A linked invoice attribution failed exact provider, model, operation, amount, currency, job or immutable-ledger checks.");continue;}
    const allLines=importLineRows.get(invoice.id)||[];
    const allRecon=reconImportRows.get(invoice.id)||[];
    const lineTotal=allLines.reduce((sum,row)=>sum+(amount(row.amount_minor)??NaN),0);
    if(allLines.length!==Number(invoice.imported_line_count)||
       Number(invoice.matched_line_count)!==Number(invoice.imported_line_count)||
       allRecon.length!==allLines.length||
       allLines.some(row=>row.match_status!=="matched")||
       allRecon.some(row=>row.match_status!=="matched")||
       !Number.isSafeInteger(lineTotal)||lineTotal!==Number(invoice.total_minor)){
      problems.push("The source invoice is not completely reconciled line-for-line to its declared total.");continue;
    }
    if(currency!==null&&currency!==curr){problems.push("A job has provider actual costs in multiple currencies; no FX conversion is inferred.");continue;}
    currency=curr;
    totalMinor+=value;
    if(!Number.isSafeInteger(totalMinor)){problems.push("Provider actual-cost total exceeds safe integer precision.");continue;}
    latestEvidenceAt=Math.max(latestEvidenceAt,Date.parse(invoice.imported_at),Date.parse(cost.created_at));
    accepted.push({usageEventId:usage.id,invoiceImportId:invoice.id,invoiceLineId:line.id,
      reconciliationEventId:recon.id,serviceCostEventId:cost.id,provider:usage.provider,
      model:clean(usage.response_model||usage.requested_model),operation,costCategory:expectedCostCategory,
      currency:curr,amountMinor:value,periodMonth:usage.period_month});
  }

  if(usages.some(row=>row.cost_basis==="provider_reported"&&!linkedUsageIds.has(clean(row.id))))
    problems.push("At least one provider-reported usage event has no unique posted invoice attribution.");
  if(links.length!==accepted.length)problems.push("One or more attribution links could not be verified.");
  const categories=CATEGORIES.map(category=>{
    if(category==="compute"&&accepted.length&&problems.length===0&&currency){
      const amountMicros=currencyMinorToMicros(totalMinor,currency);
      if(amountMicros===null)return {category,status:"amount_precision_unsupported",reason:"Currency minor-unit precision cannot be represented safely in the evidence unit."};
      const sourceDigest=hash({version:"job-invoice-cost-bundle-v1",jobId:id,currency,totalMinor,records:accepted});
      return {category,status:"verified_historical_actual",currency,amountMinor:totalMinor,amountMicros,
        sourceRecordId:"job-invoice-cost-bundle:"+id,sourceDigest,sourceCount:accepted.length,
        observedAt:new Date(latestEvidenceAt).toISOString()};
    }
    return {category,status:"missing_job_level_evidence",
      reason:category==="compute"
        ?"No complete, exact, posted provider-invoice attribution chain is available for this job."
        :"Existing shared/monthly ledgers do not carry a verified exact job-level attribution for this category."};
  });
  const verifiedCompute=categories.find(row=>row.category==="compute")?.status==="verified_historical_actual";
  const missingCategories=categories.filter(row=>row.status!=="verified_historical_actual").map(row=>row.category);
  return Object.freeze({
    jobId:id,status:problems.length?"source_evidence_exceptions":verifiedCompute?"partial_historical_actuals":"no_verified_job_cost_actuals",
    providerCompute:categories[0],categories:Object.freeze(categories),verifiedProviderInvoiceLinks:accepted.length,
    sourceExceptions:Object.freeze([...new Set(problems)]),
    fullyLoadedReady:false,dispatchEvidenceEligible:false,missingCategories:Object.freeze(missingCategories),
    limitations:Object.freeze([
      "Provider compute actuals are historical only and are not a future quote or per-shot forecast.",
      "Shared monthly/customer-level costs are not forced onto an individual job.",
      "Payment processing, moderation, retries, tax, refund reserve and support require exact job-level source records before attribution.",
      "Storage and egress require job-level metering; owner-level/month-level totals are not treated as per-job evidence.",
      "Credits are not cash revenue, and this report does not calculate gross margin.",
      "This read-only report never writes financial ledgers, settles credits, authorizes dispatch or releases provider execution."
    ])
  });
}
