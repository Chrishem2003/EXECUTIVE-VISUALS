import { createHash } from "node:crypto";

const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const text=(v,label,max=180)=>{if(typeof v!=="string"||!v.trim()||v.trim().length>max)fail("FINANCIAL_CLOSE_INPUT_INVALID",label+" must be a non-empty string of at most "+max+" characters.");return v.trim();};
const list=(v,label,max=500)=>{if(!Array.isArray(v)||v.length>max)fail("FINANCIAL_CLOSE_ROWS_INVALID",label+" must be an array with no more than "+max+" records.");return v;};
const iso=(v,label)=>{const s=text(v,label,40);if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}(T.*)?$/.test(s)||!Number.isFinite(Date.parse(s))||(s.length===10&&new Date(s+"T00:00:00.000Z").toISOString().slice(0,10)!==s))fail("FINANCIAL_CLOSE_DATE_INVALID",label+" must be a valid ISO date or timestamp.");return s;};
const period=(v)=>{const s=text(v,"period",7);if(!/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(s))fail("FINANCIAL_CLOSE_PERIOD_INVALID","period must use YYYY-MM format.");return s;};
const evidenceIndex=(items)=>{
 const map=new Map();
 for(const item of list(items||[],"evidence",1000)){
  const id=text(item.evidenceId,"evidenceId",120);
  if(map.has(id))fail("FINANCIAL_CLOSE_EVIDENCE_DUPLICATE","Evidence identifiers must be unique.");
  const digest=text(item.sha256,"evidence sha256",64).toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(digest))fail("FINANCIAL_CLOSE_EVIDENCE_HASH_INVALID","Evidence sha256 must be a 64-character hexadecimal digest.");
  map.set(id,{evidenceId:id,sha256:digest,sourceType:text(item.sourceType,"evidence sourceType",80),sourceReference:text(item.sourceReference,"evidence sourceReference",240),period:period(item.period),recordedAt:iso(item.recordedAt,"evidence recordedAt"),recordedBy:text(item.recordedBy,"evidence recordedBy",120)});
 }
 return map;
};
const refs=(values,map,label)=>{
 if(values==null)return [];if(!Array.isArray(values))fail("FINANCIAL_CLOSE_EVIDENCE_REQUIRED",label+" evidence references must be an array.");
 const out=[];
 for(const id of values){const key=text(id,label+" evidence reference",120),item=map.get(key);if(!item)fail("FINANCIAL_CLOSE_EVIDENCE_MISSING","Referenced evidence "+key+" does not exist in the supplied evidence manifest.");out.push(key);}
 return [...new Set(out)].sort();
};
const canonical=value=>Array.isArray(value)?"["+value.map(canonical).join(",")+"]":value&&typeof value==="object"?"{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonical(value[k])).join(",")+"}":JSON.stringify(value);
const sum=(items,field)=>items.reduce((n,x)=>n+(Number.isSafeInteger(x[field])?x[field]:0),0);

export function assessFinancialCloseReadiness(input={}){
 const closePeriod=period(input.period),asOf=iso(input.asOf||new Date().toISOString(),"asOf"),evidence=evidenceIndex(input.evidence||[]);\n for(const item of evidence.values())if(item.period!==closePeriod)fail("FINANCIAL_CLOSE_EVIDENCE_PERIOD_MISMATCH","Every evidence record must belong to the assessed close period.");
 const tasks=list(input.tasks||[],"tasks",300).map((x,index)=>{
  const id=text(x.taskId,"taskId",120),title=text(x.title,"task title",180),owner=text(x.ownerId,"task ownerId",120),reviewer=x.reviewerId==null?null:text(x.reviewerId,"task reviewerId",120),status=text(x.status,"task status",32).toLowerCase();
  if(!["not_started","in_progress","completed","blocked","waived"].includes(status))fail("FINANCIAL_CLOSE_TASK_STATUS_INVALID","Task status must be not_started, in_progress, completed, blocked or waived.");
  const dueAt=x.dueAt==null?null:iso(x.dueAt,"task dueAt"),completedAt=x.completedAt==null?null:iso(x.completedAt,"task completedAt");
  const evidenceRefs=status==="waived"?[]:refs(x.evidenceRefs,evidence,"Task "+id);
  const approval=x.approval||null;
  const approvedBy=approval?.approvedBy==null?null:text(approval.approvedBy,"task approval approvedBy",120);
  const approvedAt=approval?.approvedAt==null?null:iso(approval.approvedAt,"task approval approvedAt");
  const decision=approval?.decision==null?null:text(approval.decision,"task approval decision",24).toLowerCase();
  const issues=[];
  if(!reviewer)issues.push("independent_reviewer_missing");\n  if(status!=="waived"&&evidenceRefs.length===0)issues.push("missing_evidence");
  if(reviewer&&reviewer===owner)issues.push("preparer_reviewer_conflict");
  if(status==="completed"&&!completedAt)issues.push("completion_timestamp_missing");\n  if(status==="completed"&&!approval?.preparedBy)issues.push("preparer_attestation_missing");
  if(approval?.preparedBy&&approval.preparedBy!==owner)issues.push("preparer_attestation_mismatch");
  if(approvedBy&&reviewer&&approvedBy!==reviewer)issues.push("reviewer_approval_mismatch");
  if(status==="completed"&&(!approvedBy||!approvedAt||decision!=="approved"))issues.push("independent_approval_missing");
  if(approvedBy&&approvedBy===owner)issues.push("self_approval_prohibited");
  if(status==="blocked")issues.push("task_blocked");
  if(status!=="completed"&&status!=="waived")issues.push("task_incomplete");
  if(dueAt&&Date.parse(dueAt)<Date.parse(asOf)&&status!=="completed"&&status!=="waived")issues.push("task_overdue");
  if(status==="waived"&&!text(x.waiverReason,"waiverReason",500))issues.push("waiver_reason_missing");
  return {index,taskId:id,title,ownerId:owner,reviewerId:reviewer,status,dueAt,completedAt,evidenceRefs,approval:approval?{approvedBy,approvedAt,decision}:null,issues};
 });
 const ids=new Set();for(const t of tasks){if(ids.has(t.taskId))fail("FINANCIAL_CLOSE_TASK_DUPLICATE","Task identifiers must be unique.");ids.add(t.taskId);}
 const reconciliations=list(input.reconciliations||[],"reconciliations",500).map((x,index)=>{
  const id=text(x.reconciliationId,"reconciliationId",120),status=text(x.status,"reconciliation status",32).toLowerCase(),currency=text(x.currency,"reconciliation currency",3).toUpperCase();
  if(!/^[A-Z]{3}$/.test(currency))fail("FINANCIAL_CLOSE_CURRENCY_INVALID","Reconciliation currency must be a three-letter ISO code.");
  if(!["matched","approved","open","variance","rejected","not_applicable"].includes(status))fail("FINANCIAL_CLOSE_RECON_STATUS_INVALID","Unsupported reconciliation status.");
  const varianceMinor=x.varianceMinor==null?0:x.varianceMinor;
  if(!Number.isSafeInteger(varianceMinor))fail("FINANCIAL_CLOSE_AMOUNT_INVALID","Reconciliation variance must be an integer minor-unit amount.");
  const preparedBy=x.preparedBy==null?null:text(x.preparedBy,"reconciliation preparedBy",120),reviewedBy=x.reviewedBy==null?null:text(x.reviewedBy,"reconciliation reviewedBy",120);
  const evidenceRefs=status==="not_applicable"?[]:refs(x.evidenceRefs,evidence,"Reconciliation "+id);
  const issues=[];
  if(status==="open"||status==="variance"||status==="rejected")issues.push("reconciliation_exception");
  if(["matched","approved"].includes(status)&&!reviewedBy)issues.push("independent_review_missing");\n  if(status!=="not_applicable"&&evidenceRefs.length===0)issues.push("missing_evidence");
  if(preparedBy&&reviewedBy&&preparedBy===reviewedBy)issues.push("preparer_reviewer_conflict");
  if(status==="not_applicable"&&!text(x.reason,"not_applicable reason",500))issues.push("not_applicable_reason_missing");
  return {index,reconciliationId:id,status,currency,varianceMinor,preparedBy,reviewedBy,evidenceRefs,issues};
 });
 const recIds=new Set();for(const r of reconciliations){if(recIds.has(r.reconciliationId))fail("FINANCIAL_CLOSE_RECON_DUPLICATE","Reconciliation identifiers must be unique.");recIds.add(r.reconciliationId);}
 const blockers=[];
 for(const t of tasks)for(const issue of t.issues)if(issue!=="task_incomplete")blockers.push({type:"task",reference:t.taskId,issue});
 for(const r of reconciliations)for(const issue of r.issues)blockers.push({type:"reconciliation",reference:r.reconciliationId,issue});
 const incompleteTasks=tasks.filter(x=>x.status!=="completed"&&x.status!=="waived").length;
 const openReconciliations=reconciliations.filter(x=>!["approved","not_applicable"].includes(x.status)).length;
 const evidenceReferences=[...tasks.flatMap(x=>x.evidenceRefs),...reconciliations.flatMap(x=>x.evidenceRefs)].sort();
 const evidenceManifest=[...new Set(evidenceReferences)].map(id=>evidence.get(id)).sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId));
 const evidenceDigest=createHash("sha256").update(canonical({period:closePeriod,evidence:evidenceManifest})).digest("hex");
 const criticalBlockers=blockers.length+incompleteTasks+openReconciliations;
 const status=criticalBlockers===0?"eligible_for_human_signoff":"blocked";
 const total=tasks.length+reconciliations.length,completed=tasks.filter(x=>x.status==="completed"||x.status==="waived").length+reconciliations.filter(x=>["approved","not_applicable"].includes(x.status)).length;
 return {period:closePeriod,asOf,mode:"read_only_close_readiness",status,eligibleForHumanSignoff:status==="eligible_for_human_signoff",automaticClose:false,automaticJournalPosting:false,summary:{taskCount:tasks.length,completedTasks:tasks.filter(x=>x.status==="completed").length,waivedTasks:tasks.filter(x=>x.status==="waived").length,incompleteTasks,reconciliationCount:reconciliations.length,openReconciliations,evidenceCount:evidenceManifest.length,blockerCount:blockers.length,completionPercent:total?Math.round(completed/total*100):0},blockers,tasks,reconciliations,evidenceManifest,evidenceManifestSha256:evidenceDigest,controls:{segregationOfDutiesEnforced:true,selfApprovalAllowed:false,missingEvidenceBlocksCompletion:true,waiversRequireReason:true,sourceFilesPersisted:false,periodLocked:false,signoffRecorded:false,limitations:["Assessment is based only on records supplied in this request.","Evidence hashes are verified for format, not against source file bytes.","No bank, provider, ledger or storage connector is called.","No journal is drafted or posted and no accounting period is locked.","A readiness result is not an audit opinion or statutory financial close."]}};
}
