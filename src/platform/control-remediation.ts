export type RemediationStatus = "unassigned" | "open" | "in_progress" | "pending_review" | "verified" | "reopened";
export type AssuranceRole = "owner" | "reviewer" | "approver" | "auditor" | "administrator";
export type ControlTestResult = "pass" | "fail" | "inconclusive";
export interface RemediationEvidence { id: string; label: string; uri?: string; checksum?: string; capturedAt: string; submittedBy: string; kind: "source" | "workpaper" | "approval" | "test" | "other"; }
export interface RemediationAction {
  id: string; findingId: string; controlId: string; title: string; severity: string;
  owner: string | null; reviewer: string | null; dueAt: string; status: RemediationStatus;
  actionPlan: string; evidence: RemediationEvidence[]; createdAt: string; updatedAt: string;
  verifiedAt: string | null; verifiedBy: string | null; reopenedCount: number;
  history: Array<{ at: string; actor: string; event: string; from?: RemediationStatus; to?: RemediationStatus; note?: string }>;
}
export interface ControlTest { id: string; controlId: string; tester: string; testedAt: string; period: string; result: ControlTestResult; sampleSize: number; exceptions: number; evidenceIds: string[]; notes: string; }
export interface AccessCertification { id: string; subject: string; role: string; scope: string; reviewer: string; reviewedAt: string; decision: "retain" | "revoke" | "modify" | "exception"; rationale: string; }
type Finding = { id: string; controlId: string; title: string; severity: string; recommendedAction: string; status: string; count: number };
type Assessment = { findings?: Finding[]; controls?: Array<{id:string;owner?:string}> };
const severityDays: Record<string, number> = { critical: 1, high: 5, medium: 15, low: 30, unknown: 14 };
const validDate = (v: unknown): number | null => { const n = Date.parse(String(v ?? "")); return Number.isFinite(n) ? n : null; };
const safe = (v: unknown, max = 500): string => typeof v === "string" ? v.trim().slice(0,max) : "";
const idFor = (findingId: string) => "rem-" + findingId.replace(/[^a-zA-Z0-9_-]/g,"-").slice(0,100);
export function buildRemediationRegister(assessment: Assessment, existing: RemediationAction[] = [], asOf = new Date().toISOString()) {
  const now = validDate(asOf) ?? Date.now();
  const controls = new Map((assessment.controls ?? []).map(c => [c.id,c]));
  const byFinding = new Map(existing.map(x => [x.findingId,x]));
  const generated: RemediationAction[] = [];
  for (const finding of assessment.findings ?? []) {
    if (!finding || finding.status === "not_assessed" || finding.status === "evidence_gap") continue;
    const previous = byFinding.get(finding.id);
    if (previous) { generated.push(previous); continue; }
    const days = severityDays[finding.severity] ?? 14;
    const dueAt = new Date(now + days * 86400000).toISOString();
    const owner = safe(controls.get(finding.controlId)?.owner,120) || null;
    generated.push({
      id:idFor(finding.id), findingId:finding.id, controlId:finding.controlId, title:safe(finding.title,200),
      severity:finding.severity, owner, reviewer:null, dueAt, status:owner ? "open" : "unassigned",
      actionPlan:safe(finding.recommendedAction,1000), evidence:[], createdAt:new Date(now).toISOString(),
      updatedAt:new Date(now).toISOString(), verifiedAt:null, verifiedBy:null, reopenedCount:0,
      history:[{at:new Date(now).toISOString(),actor:"system",event:"remediation_created",note:"Generated from a current governance finding; owner assignment and due date require human confirmation."}]
    });
  }
  return generated.sort((a,b)=>(severityDays[a.severity]??14)-(severityDays[b.severity]??14) || a.dueAt.localeCompare(b.dueAt));
}
export function transitionRemediation(action: RemediationAction, input: {to:RemediationStatus; actor:string; at?:string; note?:string; evidence?:RemediationEvidence[]; actorRole:AssuranceRole}) {
  const actor=safe(input.actor,120), at=input.at ?? new Date().toISOString(), time=validDate(at);
  if (!actor || time===null) throw new Error("A valid actor and timestamp are required.");
  const allowed: Record<RemediationStatus,RemediationStatus[]> = {
    unassigned:["open"], open:["in_progress"], in_progress:["pending_review","open"], pending_review:["verified","in_progress"], verified:["reopened"], reopened:["in_progress"]
  };
  if (!allowed[action.status].includes(input.to)) throw new Error("Invalid remediation state transition.");
  if (input.to==="verified" && input.actorRole!=="reviewer" && input.actorRole!=="approver" && input.actorRole!=="auditor") throw new Error("Only an independent reviewer, approver or auditor may verify remediation.");
  if (input.to==="verified" && (!action.owner || actor===action.owner || !action.evidence?.length)) throw new Error("Independent verification requires a distinct reviewer, an assigned owner and evidence.");
  if (input.to==="pending_review" && !action.evidence.length && !input.evidence?.length) throw new Error("Attach remediation evidence before requesting review.");
  const additions=(input.evidence??[]).map(e=>({...e,label:safe(e.label,160),submittedBy:safe(e.submittedBy,120)}));
  if(additions.some(e=>!e.id||!e.label||!e.submittedBy||validDate(e.capturedAt)===null)) throw new Error("Evidence metadata is incomplete.");
  const next:RemediationAction={...action,status:input.to,updatedAt:new Date(time).toISOString(),evidence:[...action.evidence,...additions],
    verifiedAt:input.to==="verified"?new Date(time).toISOString():input.to==="reopened"?null:action.verifiedAt,
    verifiedBy:input.to==="verified"?actor:input.to==="reopened"?null:action.verifiedBy,
    reopenedCount:action.reopenedCount+(input.to==="reopened"?1:0),
    history:[...action.history,{at:new Date(time).toISOString(),actor,event:"status_transition",from:action.status,to:input.to,note:safe(input.note,500)}]};
  return next;
}
export function assessControlTests(tests: ControlTest[]) {
  const byControl = new Map<string,ControlTest[]>();
  for(const test of tests){if(!test.controlId||!test.tester||validDate(test.testedAt)===null||!Number.isSafeInteger(test.sampleSize)||test.sampleSize<0||!Number.isSafeInteger(test.exceptions)||test.exceptions<0||test.exceptions>test.sampleSize)throw new Error("Control test record is invalid.");byControl.set(test.controlId,[...(byControl.get(test.controlId)||[]),test]);}
  return [...byControl].map(([controlId,rows])=>({controlId,tests:rows.length,latest:rows.slice().sort((a,b)=>b.testedAt.localeCompare(a.testedAt))[0],result:rows.some(x=>x.result==="fail"||x.exceptions>0)?"attention":rows.some(x=>x.result==="inconclusive")?"inconclusive":"pass"}));
}
export function summarizeRemediationRisk(actions: RemediationAction[], asOf = new Date().toISOString()) {
  const now=validDate(asOf)??Date.now();
  const open=actions.filter(x=>x.status!=="verified");
  const overdue=open.filter(x=>(validDate(x.dueAt)??Infinity)<now);
  const ageDays=(x:RemediationAction)=>Math.max(0,Math.floor((now-(validDate(x.createdAt)??now))/86400000));
  return {total:actions.length,open:open.length,overdue:overdue.length,critical:open.filter(x=>x.severity==="critical").length,awaitingReview:open.filter(x=>x.status==="pending_review").length,reopened:actions.filter(x=>x.reopenedCount>0).length,averageOpenAgeDays:open.length?Math.round(open.reduce((s,x)=>s+ageDays(x),0)/open.length):0,bySeverity:Object.fromEntries(["critical","high","medium","low","unknown"].map(s=>[s,open.filter(x=>x.severity===s).length]))};
}
export function validateAccessCertification(rows: AccessCertification[]) {
  const seen=new Set<string>();
  for(const row of rows){const key=[row.subject,row.role,row.scope].join("|").toLowerCase();if(!row.subject||!row.role||!row.scope||!row.reviewer||row.subject===row.reviewer||validDate(row.reviewedAt)===null)throw new Error("Access certification requires a distinct reviewer and complete scope.");if(seen.has(key))throw new Error("Duplicate access certification row.");seen.add(key);}
  return {reviewed:rows.length,retain:rows.filter(x=>x.decision==="retain").length,revoke:rows.filter(x=>x.decision==="revoke").length,modify:rows.filter(x=>x.decision==="modify").length,exceptions:rows.filter(x=>x.decision==="exception").length,limitations:["This is a certification assessment of supplied records, not a live identity-provider entitlement scan.","A revoke or modify decision is a recommendation; no access is changed automatically."]};
}
