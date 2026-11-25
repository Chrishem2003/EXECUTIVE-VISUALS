const CURRENCY=/^[A-Z]{3}$/;
const HASH=/^[a-f0-9]{64}$/;
const MAX_ROWS=5000;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
function list(value,label){
 if(!Array.isArray(value)||value.length>MAX_ROWS)fail("PROVIDER_COST_REPORT_INPUT_INVALID",label+" must be an array of at most 5,000 rows.");
 return value;
}
function id(value,label){
 if(typeof value!=="string"||!value.trim()||value.trim().length>180)fail("PROVIDER_COST_REPORT_INPUT_INVALID",label+" is missing or invalid.");
 return value.trim();
}
function integer(value,label,{min=0,max=Number.MAX_SAFE_INTEGER}={}){
 const n=typeof value==="number"?value:typeof value==="string"&&/^-?[0-9]+$/.test(value)?Number(value):NaN;
 if(!Number.isSafeInteger(n)||n<min||n>max)fail("PROVIDER_COST_REPORT_INPUT_INVALID",label+" must be a safe integer in range.");
 return n;
}
function signedInteger(value,label){
 const n=typeof value==="number"?value:typeof value==="string"&&/^-?[0-9]+$/.test(value)?Number(value):NaN;
 if(!Number.isSafeInteger(n))fail("PROVIDER_COST_REPORT_INPUT_INVALID",label+" must be a safe integer.");
 return n;
}
function curr(value,label){
 const v=String(value||"").toUpperCase();
 if(!CURRENCY.test(v))fail("PROVIDER_COST_REPORT_CURRENCY_INVALID",label+" must be an ISO 4217 currency.");
 return v;
}
function add(map,currency,amount){
 const next=(map[currency]||0)+amount;
 if(!Number.isSafeInteger(next))fail("PROVIDER_COST_REPORT_OVERFLOW","Currency total exceeds safe integer bounds.");
 map[currency]=next;
}
function iso(value,label){
 const v=String(value||"");
 const ms=Date.parse(v);
 if(!Number.isFinite(ms)||!/(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(v))
  fail("PROVIDER_COST_REPORT_TIMESTAMP_INVALID",label+" must be an ISO-8601 timestamp with an explicit timezone.");
 return new Date(ms).toISOString();
}

/**
 * Read-only provider cost report. Evidence is adapter-verified when written,
 * but this report does not claim an independent provider-invoice reconciliation.
 * It never converts customer credit units into money or writes a financial ledger.
 */
export function buildProviderCostReconciliationReport(input={}){
 const approvals=list(input.approvals||[],"approvals");
 const tasks=list(input.tasks||[],"tasks");
 const evidence=list(input.evidence||[],"evidence");
 const approvalById=new Map();
 for(const a of approvals){
  const approvalId=id(a.id,"approval id");
  if(approvalById.has(approvalId))fail("PROVIDER_COST_REPORT_DUPLICATE_APPROVAL","Approval IDs must be unique.");
  approvalById.set(approvalId,{
   id:approvalId,ownerId:id(a.owner_id,"approval owner"),projectId:id(a.project_id,"approval project"),
   currency:curr(a.currency,"approval currency"),createdAt:iso(a.created_at,"approval created_at")
  });
 }
 const taskIds=new Set();
 const evidenceByTask=new Map();
 for(const e of evidence){
  const taskId=id(e.task_id,"evidence task_id");
  if(!evidenceByTask.has(taskId))evidenceByTask.set(taskId,[]);
  evidenceByTask.get(taskId).push(e);
 }
 const totals={estimatedCostMicrosByCurrency:{},actualCostMicrosByCurrency:{},varianceMicrosByCurrency:{}};
 const counts={tasks:0,verified:0,pendingTasks:0,missingEvidence:0,unknownOutcome:0,multipleEvidence:0,identityMismatch:0,invalidEvidence:0,orphanTasks:0};
 const items=[];
 for(const t of tasks){
  const taskId=id(t.id,"task id");
  if(taskIds.has(taskId))fail("PROVIDER_COST_REPORT_DUPLICATE_TASK","Task IDs must be unique.");
  taskIds.add(taskId);
  const approval=approvalById.get(id(t.approval_id,"task approval_id"));
  if(!approval){counts.orphanTasks++;continue;}
  if(t.owner_id!==approval.ownerId||t.project_id!==approval.projectId)
   fail("PROVIDER_COST_REPORT_APPROVAL_SCOPE_MISMATCH","Task owner/project scope differs from its approval.");
  const currency=curr(t.currency,"task currency");
  if(currency!==approval.currency)fail("PROVIDER_COST_REPORT_CURRENCY_MISMATCH","Task currency differs from its approval currency.");
  const estimatedCostMicros=integer(t.estimated_cost_micros,"task estimated_cost_micros");
  add(totals.estimatedCostMicrosByCurrency,currency,estimatedCostMicros);
  counts.tasks++;
  const matches=evidenceByTask.get(taskId)||[];
  const base={
   taskId,approvalId:approval.id,ownerId:approval.ownerId,projectId:approval.projectId,
   shotIndex:integer(t.shot_index,"task shot_index",{max:99}),
   provider:id(t.provider,"task provider"),model:t.model==null?null:id(t.model,"task model"),
   taskState:id(t.state,"task state"),currency,estimatedCostMicros,
   createdAt:iso(t.created_at,"task created_at")
  };
  if(matches.length===0){
   if(!["succeeded","failed"].includes(base.taskState)){
    counts.pendingTasks++;
    items.push({...base,evidenceStatus:"pending",outcome:null,actualCostMicros:null,varianceMicros:null,evidence:null});
   }else{
    counts.missingEvidence++;
    items.push({...base,evidenceStatus:"missing",outcome:null,actualCostMicros:null,varianceMicros:null,evidence:null});
   }
   continue;
  }
  if(!["succeeded","failed"].includes(base.taskState)){
   counts.pendingTasks++;
   items.push({...base,evidenceStatus:"task_not_terminal",outcome:null,actualCostMicros:null,varianceMicros:null,evidence:null});
   continue;
  }
  if(matches.length!==1){
   counts.multipleEvidence++;
   items.push({...base,evidenceStatus:"multiple_evidence_records",outcome:null,actualCostMicros:null,varianceMicros:null,
    evidence:matches.map(e=>({evidenceId:String(e.evidence_id||""),sourceReference:String(e.source_reference||""),observedAt:e.observed_at||null}))});
   continue;
  }
  const e=matches[0];
  const evidenceId=id(e.evidence_id,"evidence id");
  const provider=id(e.provider,"evidence provider");
  const providerTaskId=id(e.provider_task_id,"evidence provider_task_id");
  const evidenceModel=id(e.model,"evidence model");
  const route=id(e.route,"evidence route");
  const outcome=id(e.outcome,"evidence outcome");
  const finalState=id(e.final_state,"evidence final_state");
  const evidenceCurrency=curr(e.currency,"evidence currency");
  const observedAt=iso(e.observed_at,"evidence observed_at");
  const sourceReference=id(e.source_reference,"evidence source reference");
  const evidenceDigest=String(e.evidence_digest||"").toLowerCase();
  const evidenceEstimate=integer(e.estimated_cost_micros,"evidence estimated_cost_micros");
  const billableSeconds=integer(e.billable_seconds,"evidence billable_seconds",{max:604800});
  const inputReferenceCount=integer(e.input_reference_count,"evidence input_reference_count",{max:1000});
  if(typeof e.audio_enabled!=="boolean"||!HASH.test(evidenceDigest)||!["succeeded","failed","cancelled"].includes(finalState)||
     !["charged","no_charge","unknown"].includes(outcome)){
   counts.invalidEvidence++;
   items.push({...base,evidenceStatus:"invalid_evidence",outcome,actualCostMicros:null,varianceMicros:null,
    evidence:{evidenceId,sourceReference,observedAt}});
   continue;
  }
  if(provider!==base.provider||providerTaskId!==String(t.provider_task_id||"")||!base.model||evidenceModel!==base.model||
     evidenceCurrency!==currency||evidenceEstimate!==estimatedCostMicros){
   counts.identityMismatch++;
   items.push({...base,evidenceStatus:"identity_mismatch",outcome,actualCostMicros:null,varianceMicros:null,
    evidence:{evidenceId,provider,providerTaskId,model:evidenceModel,route,currency:evidenceCurrency,sourceReference,observedAt,evidenceDigest}});
   continue;
  }
  if(outcome==="unknown"){
   if(e.actual_cost_micros!==null||e.variance_micros!==null){
    counts.invalidEvidence++;
    items.push({...base,evidenceStatus:"invalid_evidence",outcome,actualCostMicros:null,varianceMicros:null,evidence:{evidenceId,sourceReference,observedAt}});
   }else{
    counts.unknownOutcome++;
    items.push({...base,evidenceStatus:"unknown",outcome,actualCostMicros:null,varianceMicros:null,
     evidence:{evidenceId,sourceReference,observedAt,evidenceDigest,finalState}});
   }
   continue;
  }
  const actualCostMicros=integer(e.actual_cost_micros,"evidence actual_cost_micros");
  const varianceMicros=signedInteger(e.variance_micros,"evidence variance_micros");
  if(!Number.isSafeInteger(varianceMicros)||varianceMicros!==actualCostMicros-estimatedCostMicros||
     (outcome==="no_charge"&&(actualCostMicros!==0||billableSeconds!==0))||
     (outcome==="charged"&&actualCostMicros<1)){
   counts.invalidEvidence++;
   items.push({...base,evidenceStatus:"invalid_evidence",outcome,actualCostMicros:null,varianceMicros:null,evidence:{evidenceId,sourceReference,observedAt}});
   continue;
  }
  counts.verified++;
  add(totals.actualCostMicrosByCurrency,currency,actualCostMicros);
  add(totals.varianceMicrosByCurrency,currency,varianceMicros);
  items.push({...base,evidenceStatus:"verified_provider_reported",outcome,actualCostMicros,varianceMicros,
   evidence:{evidenceId,sourceReference,observedAt,evidenceDigest,finalState,route,billableSeconds,inputReferenceCount,audioEnabled}});
 }
 const orphanEvidence=Array.from(evidenceByTask.keys()).filter(taskId=>!taskIds.has(taskId)).length;
 const incomplete=counts.pendingTasks+counts.missingEvidence+counts.unknownOutcome+counts.multipleEvidence+counts.identityMismatch+counts.invalidEvidence+counts.orphanTasks>0||orphanEvidence>0;
 return {
  reportVersion:"1.0",reportType:"provider_cost_reconciliation",
  sourceType:"adapter_verified_provider_outcome_not_invoice_reconciled",
  status:counts.tasks===0&&counts.orphanTasks===0&&orphanEvidence===0
   ?"no_data":incomplete?"incomplete":"complete_provider_outcomes",
  automaticPosting:false,generatedAt:input.generatedAt||new Date().toISOString(),
  summary:{...counts,orphanEvidence,evidenceCoveragePct:counts.tasks?Math.round(counts.verified/counts.tasks*10000)/100:0,
   totals},
  items,
  controls:[
   "Provider-reported actual costs are adapter-verified evidence, not an independent invoice-to-ledger reconciliation.",
   "Currency totals are kept separate; no foreign-exchange conversion is inferred.",
   "Customer credit units are not money and are not converted into recognized revenue.",
   "Missing, unknown, duplicate or identity-mismatched outcomes are excluded from actual-cost totals.",
   "This report is read-only and never settles credits, releases reservations, issues refunds or posts ledger entries."
  ]
 };
}
