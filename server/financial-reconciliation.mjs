const CURRENCY=/^[A-Z]{3}$/;
const MAX_ROWS=5000;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
function rows(value,label){
 if(!Array.isArray(value)||value.length>MAX_ROWS)fail("FINANCIAL_RECON_ROWS_INVALID",label+" must be an array of at most 5,000 records.");
 return value;
}
function text(value,label,max=180){
 const v=String(value??"").trim();
 if(!v||v.length>max)fail("FINANCIAL_RECON_FIELD_INVALID",label+" is missing or too long.");
 return v;
}
function currency(value){
 const v=text(value,"currency",3).toUpperCase();
 if(!CURRENCY.test(v))fail("FINANCIAL_RECON_CURRENCY_INVALID","Currency must be an ISO 4217 three-letter code.");
 return v;
}
function amount(value,label){
 const n=Number(value);
 if(!Number.isSafeInteger(n)||n<0)fail("FINANCIAL_RECON_AMOUNT_INVALID",label+" must be a non-negative integer in currency minor units.");
 return n;
}
function normalizedReference(value){return text(value,"reference",180).toUpperCase().replace(/[\s-]+/g,"");}
function key(...values){return values.map(v=>String(v).toLowerCase()).join("\u001f");}
function countBy(items,fn){const m=new Map();for(const item of items){const k=fn(item);m.set(k,(m.get(k)||0)+1);}return m;}
function totals(items,field,currencyField){
 const result={};
 for(const item of items){const c=item[currencyField];result[c]=(result[c]||0)+item[field];}
 return result;
}
function summary(kind,rowsOut,totalsOut){
 const counts={matched:0,unmatched:0,duplicate:0,variance:0,invalid:0};
 for(const row of rowsOut)counts[row.status]=(counts[row.status]||0)+1;
 const exceptionCount=rowsOut.filter(r=>r.status!=="matched").length;
 return {kind,status:exceptionCount===0?"balanced_pending_human_review":"exceptions_found",automaticPosting:false,counts,totals:totalsOut,rows:rowsOut,
  limitations:["Matching is deterministic and exact-reference only; no fuzzy match is auto-cleared.","This preview does not write ledger entries, issue refunds, initiate payments or change subscription status.","Every match remains subject to authorized finance review and the existing posting/approval controls.","Currencies are reconciled separately; no foreign-exchange rate is inferred."]};
}
export function detectDuplicateInvoices(input={}){
 const invoices=rows(input.invoices,"invoices");
 const normalized=invoices.map((invoice,index)=>{
  const provider=text(invoice.provider,"provider",80).toLowerCase();
  const invoiceReference=normalizedReference(invoice.invoiceReference);
  const curr=currency(invoice.currency);
  const totalMinor=amount(invoice.totalMinor,"invoice total");
  return {index,provider,invoiceReference,currency:curr,totalMinor,sourceId:invoice.sourceId==null?null:String(invoice.sourceId)};
 });
 const counts=countBy(normalized,x=>key(x.provider,x.invoiceReference,x.currency));
 const groups=new Map();
 for(const item of normalized){const k=key(item.provider,item.invoiceReference,item.currency);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(item);}
 const result=[];
 for(const group of groups.values()){
  if(group.length<2)continue;
  result.push({status:"duplicate",provider:group[0].provider,invoiceReference:group[0].invoiceReference,currency:group[0].currency,records:group.map(x=>({index:x.index,sourceId:x.sourceId,totalMinor:x.totalMinor})),reason:"Same provider, normalized invoice reference and currency occur more than once."});
 }
 return {kind:"provider_invoice_duplicate_scan",status:result.length?"exceptions_found":"no_duplicates_detected",automaticBlockingOnly:true,scanned:normalized.length,duplicateGroups:result.length,duplicates:result,limitations:["Duplicate detection is a review signal, not proof of fraud; credit notes, corrected invoices and split billing require human context.","Original source documents and provider account identity must be retained for verification."]};
}
export function reconcileProviderInvoiceLines(input={}){
 const invoiceLines=rows(input.invoiceLines,"invoiceLines"),usageEvents=rows(input.usageEvents,"usageEvents");
 const usage=usageEvents.map((u,index)=>({
  index,id:u.id==null?null:String(u.id),provider:text(u.provider,"usage provider",80).toLowerCase(),
  reference:normalizedReference(u.invoiceLineReference),currency:currency(u.currency),
  model:text(u.model||u.requestedModel,"usage model",160).toLowerCase(),
  operation:text(u.operation,"usage operation",32).toLowerCase(),
  usagePeriod:text(u.usagePeriod,"usage period",10),
  providerCostMinor:u.providerCostMinor==null?null:amount(u.providerCostMinor,"usage provider cost"),
  status:String(u.status||"unknown").toLowerCase()
 }));
 const index=new Map();
 for(const u of usage){const k=key(u.provider,u.reference,u.currency);if(!index.has(k))index.set(k,[]);index.get(k).push(u);}
 const consumed=new Set(),out=[];
 for(let i=0;i<invoiceLines.length;i++){
  const l=invoiceLines[i],provider=text(l.provider,"invoice provider",80).toLowerCase(),reference=normalizedReference(l.lineReference||l.providerLineReference),curr=currency(l.currency),model=text(l.model,"invoice model",160).toLowerCase(),operation=text(l.operation,"invoice operation",32).toLowerCase(),period=text(l.usagePeriod,"invoice usage period",10),amountMinor=amount(l.amountMinor,"invoice line amount");
  const candidates=index.get(key(provider,reference,curr))||[];
  if(candidates.length>1){out.push({index:i,status:"duplicate",provider,reference,currency:curr,amountMinor,candidateUsageIds:candidates.map(x=>x.id),reason:"More than one usage event shares this provider line reference and currency."});continue;}
  if(candidates.length===0){out.push({index:i,status:"unmatched",provider,reference,currency:curr,amountMinor,reason:"No provider usage event has the same provider, line reference and currency."});continue;}
  const u=candidates[0];
  if(consumed.has(u.index)){out.push({index:i,status:"duplicate",provider,reference,currency:curr,amountMinor,usageEventId:u.id,reason:"Usage event has already been matched to another invoice line."});continue;}
  consumed.add(u.index);
  if(u.model!==model||u.operation!==operation||u.usagePeriod!==period){out.push({index:i,status:"variance",provider,reference,currency:curr,amountMinor,usageEventId:u.id,reason:"Model, operation or usage period differs from the metered usage event."});continue;}
  if(u.providerCostMinor===null){out.push({index:i,status:"invalid",provider,reference,currency:curr,amountMinor,usageEventId:u.id,reason:"Usage event has no provider-reported cost; invoice amount cannot be independently verified."});continue;}
  if(u.providerCostMinor!==amountMinor){out.push({index:i,status:"variance",provider,reference,currency:curr,amountMinor,usageEventId:u.id,usageCostMinor:u.providerCostMinor,varianceMinor:amountMinor-u.providerCostMinor,reason:"Invoice line amount differs from provider-reported usage cost."});continue;}
  out.push({index:i,status:"matched",provider,reference,currency:curr,amountMinor,usageEventId:u.id,reason:"Exact one-to-one provider, line reference, currency, model, operation, period and amount match."});
 }
 const matched=out.filter(x=>x.status==="matched");
 const unused=usage.filter(x=>!consumed.has(x.index)).map(x=>({usageEventId:x.id,provider:x.provider,reference:x.reference,currency:x.currency,providerCostMinor:x.providerCostMinor,status:"unmatched",reason:"Metered usage event was not consumed by an exact invoice-line match."}));
 const currencyTotals={invoice:totals(invoiceLines.map(x=>({currency:currency(x.currency),amountMinor:amount(x.amountMinor,"invoice amount")})),"amountMinor","currency"),matched:totals(matched,"amountMinor","currency")};
 return summary("provider_invoice_to_usage",out.concat(unused),{currencyTotals,invoiceLineCount:invoiceLines.length,usageEventCount:usage.length});
}
export function reconcilePaymentSettlement(input={}){
 const statementRows=rows(input.statementRows,"statementRows"),payments=rows(input.payments,"payments");
 const normalizedPayments=payments.map((p,index)=>({index,id:p.id==null?null:String(p.id),reference:normalizedReference(p.providerReference||p.transactionReference),provider:text(p.provider,"payment provider",80).toLowerCase(),currency:currency(p.currency),amountMinor:amount(p.amountMinor,"payment amount"),status:String(p.status||"unknown").toLowerCase()}));
 const index=new Map();for(const p of normalizedPayments){const k=key(p.provider,p.reference,p.currency);if(!index.has(k))index.set(k,[]);index.get(k).push(p);}
 const seen=new Set(),out=[];
 for(let i=0;i<statementRows.length;i++){
  const s=statementRows[i],provider=text(s.provider,"statement provider",80).toLowerCase(),reference=normalizedReference(s.providerReference||s.transactionReference),curr=currency(s.currency),amountMinor=amount(s.amountMinor,"statement amount");
  const candidates=index.get(key(provider,reference,curr))||[];
  if(seen.has(key(provider,reference,curr))){out.push({index:i,status:"duplicate",provider,reference,currency:curr,amountMinor,reason:"Statement repeats a provider transaction reference."});continue;}
  seen.add(key(provider,reference,curr));
  if(candidates.length>1){out.push({index:i,status:"duplicate",provider,reference,currency:curr,amountMinor,paymentIds:candidates.map(x=>x.id),reason:"Multiple internal payment records share the same provider reference."});continue;}
  if(!candidates.length){out.push({index:i,status:"unmatched",provider,reference,currency:curr,amountMinor,reason:"No internal payment record has the same provider reference and currency."});continue;}
  const p=candidates[0];
  if(!["succeeded","successful","paid","settled","completed"].includes(p.status)){out.push({index:i,status:"variance",provider,reference,currency:curr,amountMinor,paymentId:p.id,paymentStatus:p.status,reason:"Internal payment is not in a settled success state."});continue;}
  if(p.amountMinor!==amountMinor){out.push({index:i,status:"variance",provider,reference,currency:curr,amountMinor,paymentId:p.id,paymentAmountMinor:p.amountMinor,varianceMinor:amountMinor-p.amountMinor,reason:"Statement settlement amount differs from the recorded payment amount."});continue;}
  out.push({index:i,status:"matched",provider,reference,currency:curr,amountMinor,paymentId:p.id,reason:"Exact provider reference, currency, settled status and amount match."});
 }
 const matched=out.filter(x=>x.status==="matched");
 const unused=normalizedPayments.filter(p=>!out.some(x=>x.paymentId===p.id&&x.status==="matched")).map(p=>({paymentId:p.id,provider:p.provider,reference:p.reference,currency:p.currency,amountMinor:p.amountMinor,status:"unmatched",reason:"Internal payment was not matched to a statement settlement row."}));
 return summary("payment_settlement",out.concat(unused),{currencyTotals:{statement:totals(statementRows.map(x=>({currency:currency(x.currency),amountMinor:amount(x.amountMinor,"statement amount")})),"amountMinor","currency"),matched:totals(matched,"amountMinor","currency")},statementRowCount:statementRows.length,paymentRecordCount:payments.length});
}
