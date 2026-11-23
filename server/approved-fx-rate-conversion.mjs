const DECIMALS={UGX:0,USD:2,EUR:2,GBP:2,KES:2,TZS:2,RWF:0,JPY:0};
const SCALE=100000000n;
const nextMonth=month=>{const [year,mon]=String(month).split('-').map(Number);return new Date(Date.UTC(year,mon,1)).toISOString().slice(0,10);};
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const isDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(String(value||''))&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;

/** Convert a minor-unit amount only with an approved, same-period settlement FX record. */
export function convertProviderCostWithApprovedFx({amountMinor,sourceCurrency,targetCurrency,periodMonth,fxEvidence}={}){
 if(!Number.isSafeInteger(amountMinor)||amountMinor<0||amountMinor>9000000000000)fail('FX_CONVERSION_AMOUNT_INVALID','Provider cost must be a bounded non-negative minor-unit integer.');
 if(!Object.hasOwn(DECIMALS,sourceCurrency)||!Object.hasOwn(DECIMALS,targetCurrency)||sourceCurrency===targetCurrency)
  fail('FX_CONVERSION_CURRENCY_UNSUPPORTED','Currency pair is unsupported or identical.');
 if(!/^\d{4}-\d{2}-01$/.test(String(periodMonth||''))||!isDate(periodMonth))fail('FX_CONVERSION_PERIOD_INVALID','A valid reporting month is required.');
 const blocked={status:'blocked_fx_evidence',amountMinor:null,sourceCurrency,targetCurrency,periodMonth,fxEvidenceId:null,rateScaled:null,reason:'No approved settlement FX evidence is available for this currency pair and reporting month.'};
 if(!fxEvidence||typeof fxEvidence!=='object'||Array.isArray(fxEvidence))return Object.freeze(blocked);
 const e=fxEvidence;
 if(e.decision!=='approved'||e.source_currency!==sourceCurrency||e.target_currency!==targetCurrency||
    e.purpose!=='settlement_cost'||!['processor_settlement','bank_statement'].includes(e.source_type)||
    e.period_month!==periodMonth||!isDate(e.effective_date)||e.effective_date>new Date().toISOString().slice(0,10)||
    !Number.isSafeInteger(e.rate_scaled)||e.rate_scaled<=0||e.rate_scale!==100000000||
    !e.source_reference||String(e.source_reference).trim().length<3||!e.evidence_id)
  return Object.freeze({...blocked,reason:'FX evidence is unapproved, not settlement-grade, mismatched or outside the reporting month.'});
 const numerator=BigInt(amountMinor)*BigInt(e.rate_scaled)*10n**BigInt(DECIMALS[targetCurrency]);
 const denominator=SCALE*10n**BigInt(DECIMALS[sourceCurrency]);
 const converted=(numerator+denominator-1n)/denominator;
 if(converted>9000000000000n)fail('FX_CONVERSION_OVERFLOW','Converted provider cost exceeds safe calculation bounds.');
 return Object.freeze({status:'converted_with_approved_settlement_evidence',amountMinor:Number(converted),sourceAmountMinor:amountMinor,sourceCurrency,targetCurrency,periodMonth,
  fxEvidenceId:e.evidence_id,rateScaled:e.rate_scaled,rateScale:e.rate_scale,effectiveDate:e.effective_date,sourceType:e.source_type,sourceReference:e.source_reference,
  decision:'approved',decisionReason:e.decision_reason||null,decisionAt:e.decision_created_at||null,rounding:'ceil_to_target_minor_unit'});
}

export function selectApprovedSettlementFxEvidence(rows=[],{sourceCurrency,targetCurrency,periodMonth}={}){
 if(!Array.isArray(rows)||rows.length>1000)fail('FX_EVIDENCE_INPUT_INVALID','FX evidence rows must be a bounded array.');
 const eligible=rows.filter(row=>row&&row.decision==='approved'&&row.source_currency===sourceCurrency&&row.target_currency===targetCurrency&&
  row.purpose==='settlement_cost'&&['processor_settlement','bank_statement'].includes(row.source_type)&&row.period_month===periodMonth&&
  isDate(row.effective_date)&&row.effective_date<=new Date().toISOString().slice(0,10));
 eligible.sort((a,b)=>String(b.effective_date).localeCompare(String(a.effective_date))||String(b.decision_created_at||'').localeCompare(String(a.decision_created_at||'')));
 return eligible[0]||null;
}
