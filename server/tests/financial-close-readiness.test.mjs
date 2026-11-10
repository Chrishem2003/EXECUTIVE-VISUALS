import test from "node:test";
import assert from "node:assert/strict";
import {assessFinancialCloseReadiness} from "../financial-close-readiness.mjs";

const hash="a".repeat(64);
const evidence=[{evidenceId:"bank-rec",sha256:hash,sourceType:"bank_statement",sourceReference:"statement-2026-10",period:"2026-10",recordedAt:"2026-11-01T10:00:00Z",recordedBy:"finance-preparer"}];
const completeTask={taskId:"cash-close",title:"Cash reconciliation",ownerId:"preparer-1",reviewerId:"reviewer-1",status:"completed",dueAt:"2026-11-03T17:00:00Z",completedAt:"2026-11-02T12:00:00Z",evidenceRefs:["bank-rec"],approval:{preparedBy:"preparer-1",approvedBy:"reviewer-1",approvedAt:"2026-11-02T14:00:00Z",decision:"approved"}};
const completeRecon={reconciliationId:"cash-ledger",status:"approved",currency:"UGX",varianceMinor:0,preparedBy:"preparer-1",reviewedBy:"reviewer-1",evidenceRefs:["bank-rec"]};

test("a fully evidenced, independently reviewed period is eligible for human sign-off only",()=>{
 const result=assessFinancialCloseReadiness({period:"2026-10",asOf:"2026-11-04T10:00:00Z",evidence,tasks:[completeTask],reconciliations:[completeRecon]});
 assert.equal(result.status,"eligible_for_human_signoff");
 assert.equal(result.eligibleForHumanSignoff,true);
 assert.equal(result.automaticClose,false);
 assert.equal(result.automaticJournalPosting,false);
 assert.equal(result.summary.completionPercent,100);
 assert.match(result.evidenceManifestSha256,/^[a-f0-9]{64}$/);
 assert.equal(result.controls.signoffRecorded,false);
});

test("incomplete tasks, overdue work, missing evidence, self-approval and reconciliation exceptions block readiness",()=>{
 const result=assessFinancialCloseReadiness({
  period:"2026-10",asOf:"2026-11-10T10:00:00Z",evidence,
  tasks:[{...completeTask,taskId:"bad-task",status:"in_progress",reviewerId:"preparer-1",evidenceRefs:[]}],
  reconciliations:[{...completeRecon,reconciliationId:"variance",status:"variance",reviewedBy:"preparer-1"}]
 });
 assert.equal(result.status,"blocked");
 assert.equal(result.eligibleForHumanSignoff,false);
 assert.ok(result.blockers.some(x=>x.issue==="preparer_reviewer_conflict"));
 assert.ok(result.blockers.some(x=>x.issue==="task_overdue"));
 assert.ok(result.blockers.some(x=>x.issue==="reconciliation_exception"));
 assert.equal(result.summary.incompleteTasks,1);
});

test("self-approved tasks cannot qualify for human sign-off",()=>{
 const result=assessFinancialCloseReadiness({period:"2026-10",asOf:"2026-11-04",evidence,tasks:[{...completeTask,approval:{approvedBy:"preparer-1",approvedAt:"2026-11-02T14:00:00Z",decision:"approved"}}],reconciliations:[completeRecon]});
 assert.equal(result.status,"blocked");
 assert.ok(result.blockers.some(x=>x.issue==="self_approval_prohibited"));
});

test("evidence must be present and carry a valid SHA-256 reference",()=>{
 const missing=assessFinancialCloseReadiness({period:"2026-10",tasks:[{...completeTask,evidenceRefs:[]}],reconciliations:[],evidence:[]});
 assert.equal(missing.status,"blocked");
 assert.ok(missing.tasks[0].issues.includes("missing_evidence"));
 assert.throws(()=>assessFinancialCloseReadiness({period:"2026-10",tasks:[],reconciliations:[],evidence:[{...evidence[0],sha256:"bad"}]}),{code:"FINANCIAL_CLOSE_EVIDENCE_HASH_INVALID"});
});

test("duplicate identifiers, invalid periods, unsafe variances and invalid statuses fail closed",()=>{
 assert.throws(()=>assessFinancialCloseReadiness({period:"2026-13",tasks:[],reconciliations:[],evidence:[]}),{code:"FINANCIAL_CLOSE_PERIOD_INVALID"});
 assert.throws(()=>assessFinancialCloseReadiness({period:"2026-10",tasks:[completeTask,completeTask],reconciliations:[],evidence}),{code:"FINANCIAL_CLOSE_TASK_DUPLICATE"});
 assert.throws(()=>assessFinancialCloseReadiness({period:"2026-10",tasks:[],reconciliations:[{...completeRecon,varianceMinor:0.5}],evidence}),{code:"FINANCIAL_CLOSE_AMOUNT_INVALID"});
 assert.throws(()=>assessFinancialCloseReadiness({period:"2026-10",tasks:[],reconciliations:[{...completeRecon,status:"mystery"}],evidence}),{code:"FINANCIAL_CLOSE_RECON_STATUS_INVALID"});
});

test("evidence manifest digest is stable regardless of source object key ordering",()=>{
 const a=assessFinancialCloseReadiness({period:"2026-10",evidence,tasks:[completeTask],reconciliations:[completeRecon]});
 const reordered={evidence:[{recordedBy:"finance-preparer",recordedAt:"2026-11-01T10:00:00Z",period:"2026-10",sourceReference:"statement-2026-10",sourceType:"bank_statement",sha256:hash,evidenceId:"bank-rec"}],tasks:[completeTask],reconciliations:[completeRecon],period:"2026-10"};
 const b=assessFinancialCloseReadiness(reordered);
 assert.equal(a.evidenceManifestSha256,b.evidenceManifestSha256);
});
