import { deriveInvoiceBackedModelCostEvidence } from "./model-invoice-cost-evidence.mjs";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIMIT=1000;
const COLUMNS="id,job_id,period_month,provider,requested_model,response_model,operation,currency,cost_basis,cost_minor";
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};

export function validateModelActualCostPeriod(value){
 const periodMonth=String(value||"");
 if(!/^\d{4}-\d{2}-01$/.test(periodMonth)||
    !Number.isFinite(Date.parse(periodMonth+"T00:00:00Z"))||
    new Date(periodMonth+"T00:00:00Z").toISOString().slice(0,10)!==periodMonth)
  fail("MODEL_ACTUAL_COST_PERIOD_INVALID","Choose a valid reporting month.");
 return periodMonth;
}

/**
 * Read-only, admin-facing invoice-backed model cost report. A bounded or
 * failed read never becomes a partial verified total: the evidence calculator
 * receives sampleComplete=false and withholds monetary totals.
 */
export async function loadModelActualCostReport({dbRequest,periodMonth}={}){
 if(typeof dbRequest!=="function")fail("MODEL_ACTUAL_COST_READER_REQUIRED","A trusted finance database reader is required.");
 const month=validateModelActualCostPeriod(periodMonth);
 const usageResult=await dbRequest("ai_usage_cost_events?select="+COLUMNS+
  "&period_month=eq."+encodeURIComponent(month)+"&order=occurred_at.asc,id.asc&limit="+LIMIT);
 const usageEvents=Array.isArray(usageResult?.data)?usageResult.data:[];
 let sampleComplete=usageEvents.length<LIMIT;
 if(!sampleComplete)return deriveInvoiceBackedModelCostEvidence({periodMonth:month,usageEvents:[],invoiceAttributions:[],sampleComplete:false});
 const ids=usageEvents.map(row=>String(row?.id||""));
 if(ids.some(id=>!UUID.test(id)))sampleComplete=false;
 const uniqueIds=[...new Set(ids)];
 if(uniqueIds.length!==ids.length)sampleComplete=false;
 let invoiceAttributions=[];
 if(sampleComplete&&uniqueIds.length){
  const attributionResult=await dbRequest("financial_cost_attribution_links?select=usage_event_id,provider,model,operation,amount_minor,currency,invoice_import_id,invoice_line_id,reconciliation_event_id,service_cost_event_id&usage_event_id=in.("+uniqueIds.join(",")+")&limit="+LIMIT);
  invoiceAttributions=Array.isArray(attributionResult?.data)?attributionResult.data:[];
  sampleComplete=invoiceAttributions.length<LIMIT;
 }
 return deriveInvoiceBackedModelCostEvidence({
  periodMonth:month,usageEvents:sampleComplete?usageEvents:[],
  invoiceAttributions:sampleComplete?invoiceAttributions:[],sampleComplete
 });
}
