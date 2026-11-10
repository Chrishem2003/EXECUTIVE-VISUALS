import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildFinancialGovernanceAssessment } from "../../src/platform/financial-governance.ts";
const app = await readFile(new URL("../../src/platform/app.ts", import.meta.url), "utf8");
const css = await readFile(new URL("../../src/platform/style.css", import.meta.url), "utf8");

test("missing source domains are reported as evidence gaps, not clean controls",()=>{
 const a=buildFinancialGovernanceAssessment({asOf:"2026-11-10T12:00:00.000Z"});
 assert.equal(a.score,null);
 assert.equal(a.coverage.available,0);
 assert.equal(a.coverage.total,8);
 assert.ok(a.summary.gaps>=4);
 assert.ok(a.findings.some(f=>f.id==="liquidity-source-gap"));
 assert.ok(a.controls.every(c=>c.status==="not_assessed"));
});

test("unresolved reconciliation and liquidity rows create evidence-linked findings",()=>{
 const a=buildFinancialGovernanceAssessment({
  asOf:"2026-11-10T12:00:00.000Z",
  liquidityAlerts:{alerts:[{id:"l1",severity:"high",status:"open"},{id:"l2",severity:"critical",status:"open"}]},
  marginAlerts:{alerts:[]},
  cashflowReconciliation:{items:[{id:"r1",status:"unmatched"},{id:"r2",status:"matched"}]},
  disputes:{cases:[]}
 });
 assert.equal(a.summary.open,3);
 assert.equal(a.summary.critical,1);
 assert.equal(a.summary.high,2);
 assert.ok(a.score!==null&&a.score>0);
 assert.ok(a.findings.some(f=>f.controlId==="CTRL-REC-01"&&f.count===1));
 assert.equal(a.controls.find(c=>c.id==="CTRL-REC-01").status,"attention");
});

test("overdue unresolved disputes escalate as critical but resolved cases do not",()=>{
 const a=buildFinancialGovernanceAssessment({
  asOf:"2026-11-10T12:00:00.000Z",
  disputes:{cases:[
   {id:"d1",status:"open",response_due_at:"2026-11-09T12:00:00.000Z"},
   {id:"d2",status:"resolved",dueAt:"2026-11-01T12:00:00.000Z"},
   {id:"d3",status:"open",dueAt:"2026-11-11T12:00:00.000Z"}
  ]}
 });
 const f=a.findings.find(x=>x.id==="dispute-deadline-overdue");
 assert.equal(f.count,1);
 assert.equal(f.severity,"critical");
});

test("invalid audit integrity creates a critical escalation and valid verification is not labelled effective",()=>{
 const invalid=buildFinancialGovernanceAssessment({auditVerification:{valid:false,firstBroken:{sequence:3,reason:"event_hash_mismatch"}}});
 assert.ok(invalid.findings.some(f=>f.id==="audit-chain-invalid"&&f.severity==="critical"));
 const valid=buildFinancialGovernanceAssessment({auditVerification:{valid:true,verifiedCount:12}});
 assert.equal(valid.controls.find(c=>c.id==="CTRL-AUD-01").status,"evidence_available");
 assert.ok(!valid.findings.some(f=>f.id==="audit-chain-not-verified"));
});

test("resolved alerts are excluded and risk index is bounded",()=>{
 const alerts=Array.from({length:10},(_,i)=>({id:String(i),severity:"critical",status:"open"}));
 alerts.push({id:"resolved",severity:"critical",status:"resolved"});
 const a=buildFinancialGovernanceAssessment({liquidityAlerts:{alerts},marginAlerts:{alerts:[]},cashflowReconciliation:{items:[]},disputes:{cases:[]}});
 assert.equal(a.findings.find(f=>f.controlId==="CTRL-LIQ-01").count,10);
 assert.equal(a.score,100);
 assert.equal(a.controls.find(c=>c.id==="CTRL-LIQ-01").status,"attention");
});

test("control coverage and limitations remain explicit even with no open findings",()=>{
 const a=buildFinancialGovernanceAssessment({
  liquidityAlerts:{alerts:[]},marginAlerts:{alerts:[]},cashflowReconciliation:{items:[]},disputes:{cases:[]},
  auditVerification:{valid:true},closeWorkflow:{periods:[]},scenarioSnapshots:{snapshots:[]}
 });
 assert.equal(a.coverage.available,7);
 assert.equal(a.coverage.total,8);
 assert.equal(a.summary.open,0);
 assert.equal(a.score,null);
 assert.ok(a.limitations.some(x=>x.includes("does not detect complete historical replacement")));
 assert.ok(a.controls.filter(c=>c.id!=="CTRL-SOD-01").every(c=>c.status==="evidence_available"));
 assert.equal(a.controls.find(c=>c.id==="CTRL-SOD-01").status,"not_assessed");
 assert.ok(a.findings.some(f=>f.id==="sod-evidence-gap"));
});

test("Batch 48 governance panel is integrated with protected audit controls and responsive styling",()=>{
 assert.match(app,/FINANCIAL GOVERNANCE · BATCH 48/);
 assert.match(app,/data-finance-governance-export/);
 assert.match(app,/data-finance-governance-audit-refresh/);
 assert.match(app,/data-finance-governance-audit-verify/);
 assert.match(app,/buildFinancialGovernanceAssessment/);
 assert.match(css,/\.governance-panel/);
 assert.match(css,/\.governance-findings/);
 assert.match(css,/@media\(max-width:700px\)/);
});
