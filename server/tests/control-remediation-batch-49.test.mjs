import test from "node:test";
import assert from "node:assert/strict";
import { buildRemediationRegister, transitionRemediation, assessControlTests, summarizeRemediationRisk, validateAccessCertification } from "../../src/platform/control-remediation.ts";
const assessment={controls:[{id:"CTRL-1",owner:"Finance owner"}],findings:[{id:"finding-1",controlId:"CTRL-1",title:"Unmatched settlement",severity:"critical",recommendedAction:"Reconcile against processor statement.",status:"open",count:1},{id:"gap",controlId:"CTRL-1",title:"Missing evidence",severity:"unknown",recommendedAction:"Load evidence",status:"evidence_gap",count:0}]};
test("register creates accountable actions only from actionable findings and retains existing workflow state",()=>{
 const rows=buildRemediationRegister(assessment,[],"2026-11-10T00:00:00.000Z");
 assert.equal(rows.length,1);assert.equal(rows[0].owner,"Finance owner");assert.equal(rows[0].status,"open");assert.equal(rows[0].dueAt,"2026-11-11T00:00:00.000Z");
 const retained={...rows[0],status:"in_progress",actionPlan:"Updated plan"};
 assert.equal(buildRemediationRegister(assessment,[retained],"2026-11-11T00:00:00.000Z")[0].actionPlan,"Updated plan");
});
test("remediation lifecycle requires evidence and independent verification",()=>{
 const [action]=buildRemediationRegister(assessment,[],"2026-11-10T00:00:00.000Z");
 const working=transitionRemediation(action,{to:"in_progress",actor:"Finance owner",actorRole:"owner"});
 assert.throws(()=>transitionRemediation(working,{to:"pending_review",actor:"Finance owner",actorRole:"owner"}),/evidence/);
 const evidence={id:"ev-1",label:"Processor reconciliation",uri:"https://example.invalid/evidence/1",capturedAt:"2026-11-10T01:00:00.000Z",submittedBy:"Finance owner",kind:"workpaper"};
 const review=transitionRemediation(working,{to:"pending_review",actor:"Finance owner",actorRole:"owner",evidence:[evidence]});
 assert.throws(()=>transitionRemediation(review,{to:"verified",actor:"Finance owner",actorRole:"owner"}),/independent/);
 const verified=transitionRemediation(review,{to:"verified",actor:"Independent reviewer",actorRole:"reviewer"});
 assert.equal(verified.status,"verified");assert.equal(verified.verifiedBy,"Independent reviewer");
 const reopened=transitionRemediation(verified,{to:"reopened",actor:"Auditor",actorRole:"auditor",note:"Evidence does not address root cause"});
 assert.equal(reopened.reopenedCount,1);assert.equal(reopened.verifiedAt,null);
});
test("invalid transitions and malformed evidence are rejected",()=>{
 const [action]=buildRemediationRegister(assessment,[],"2026-11-10T00:00:00.000Z");
 assert.throws(()=>transitionRemediation(action,{to:"verified",actor:"Reviewer",actorRole:"reviewer"}),/Invalid/);
 const working=transitionRemediation(action,{to:"in_progress",actor:"Finance owner",actorRole:"owner"});
 assert.throws(()=>transitionRemediation(working,{to:"pending_review",actor:"Finance owner",actorRole:"owner",evidence:[{id:"",label:"",capturedAt:"bad",submittedBy:"",kind:"other"}]}),/metadata/);
});
test("risk summary reports overdue, pending review, reopen and severity counts without conflating them",()=>{
 const [action]=buildRemediationRegister(assessment,[],"2026-11-01T00:00:00.000Z");
 const result=summarizeRemediationRisk([{...action,dueAt:"2026-11-02T00:00:00.000Z",status:"pending_review",reopenedCount:1}],"2026-11-10T00:00:00.000Z");
 assert.equal(result.open,1);assert.equal(result.overdue,1);assert.equal(result.awaitingReview,1);assert.equal(result.reopened,1);assert.equal(result.critical,1);
});
test("control tests validate samples and expose failed or inconclusive tests",()=>{
 assert.throws(()=>assessControlTests([{id:"t",controlId:"c",tester:"x",testedAt:"2026-11-10",period:"2026-10",result:"pass",sampleSize:2,exceptions:3,evidenceIds:[],notes:""}]),/invalid/);
 const result=assessControlTests([{id:"t",controlId:"c",tester:"x",testedAt:"2026-11-10",period:"2026-10",result:"fail",sampleSize:10,exceptions:1,evidenceIds:["ev"],notes:""}]);
 assert.equal(result[0].result,"attention");
});
test("access certification requires independent review and reports decisions without executing them",()=>{
 assert.throws(()=>validateAccessCertification([{id:"a",subject:"admin",role:"admin",scope:"finance",reviewer:"admin",reviewedAt:"2026-11-10",decision:"revoke",rationale:""}]),/distinct reviewer/);
 const result=validateAccessCertification([{id:"a",subject:"operator",role:"finance-admin",scope:"billing",reviewer:"auditor",reviewedAt:"2026-11-10",decision:"revoke",rationale:"No longer required"}]);
 assert.equal(result.revoke,1);assert.ok(result.limitations.some(x=>x.includes("no access is changed automatically")));
});
