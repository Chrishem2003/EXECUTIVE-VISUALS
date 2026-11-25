import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderCostReconciliationReport } from "../provider-cost-reconciliation-report.mjs";

const approval={id:"approval-01",owner_id:"owner-01",project_id:"project-01",currency:"USD",created_at:"2026-11-25T10:00:00+00:00"};
const task={id:"task-01",approval_id:"approval-01",owner_id:"owner-01",project_id:"project-01",shot_index:0,provider:"runway",model:"seedance-2.5",provider_task_id:"provider-task-01",state:"succeeded",currency:"USD",estimated_cost_micros:3400000,created_at:"2026-11-25T10:01:00+00:00"};
const evidence={task_id:"task-01",provider:"runway",provider_task_id:"provider-task-01",model:"seedance-2.5",route:"runway-dev",evidence_id:"invoice-line-01",outcome:"charged",final_state:"succeeded",currency:"USD",actual_cost_micros:"3500000",estimated_cost_micros:"3400000",variance_micros:"100000",billable_seconds:5,input_reference_count:0,audio_enabled:true,source_reference:"provider-usage-export:line-01",evidence_digest:"a".repeat(64),observed_at:"2026-11-25T10:05:00+00:00"};

test("reports one verified provider cost and variance without converting credits to money",()=>{
 const report=buildProviderCostReconciliationReport({approvals:[approval],tasks:[task],evidence:[evidence],generatedAt:"2026-11-25T10:06:00.000Z"});
 assert.equal(report.status,"complete_provider_outcomes");
 assert.equal(report.summary.verified,1);
 assert.equal(report.summary.totals.actualCostMicrosByCurrency.USD,3500000);
 assert.equal(report.summary.totals.varianceMicrosByCurrency.USD,100000);
 assert.equal(report.items[0].evidenceStatus,"verified_provider_reported");
 assert.equal(report.items[0].actualCostMicros,3500000);
 assert.equal(report.automaticPosting,false);
 assert.ok(report.controls.some(x=>x.includes("credit units are not money")));
});

test("keeps missing and unknown provider outcomes out of actual-cost totals",()=>{
 const unknown={...evidence,outcome:"unknown",actual_cost_micros:null,variance_micros:null};
 const report=buildProviderCostReconciliationReport({approvals:[approval],tasks:[task,{...task,id:"task-02",shot_index:1,provider_task_id:"provider-task-02"}],evidence:[unknown]});
 assert.equal(report.status,"incomplete");
 assert.equal(report.summary.unknownOutcome,1);
 assert.equal(report.summary.missingEvidence,1);
 assert.deepEqual(report.summary.totals.actualCostMicrosByCurrency,{});
});

test("flags multiple evidence records instead of double counting",()=>{
 const report=buildProviderCostReconciliationReport({approvals:[approval],tasks:[task],evidence:[evidence,{...evidence,evidence_id:"invoice-line-02"}]});
 assert.equal(report.summary.multipleEvidence,1);
 assert.equal(report.items[0].evidenceStatus,"multiple_evidence_records");
 assert.deepEqual(report.summary.totals.actualCostMicrosByCurrency,{});
});

test("flags provider, task, model and currency identity mismatches",()=>{
 const report=buildProviderCostReconciliationReport({approvals:[approval],tasks:[task],evidence:[{...evidence,provider_task_id:"wrong-task"}]});
 assert.equal(report.summary.identityMismatch,1);
 assert.deepEqual(report.summary.totals.actualCostMicrosByCurrency,{});
});

test("flags invalid no-charge amount, variance or evidence digest",()=>{
 const report=buildProviderCostReconciliationReport({approvals:[approval],tasks:[task],evidence:[{...evidence,outcome:"no_charge",actual_cost_micros:100,variance_micros:-3400000,billable_seconds:0}]});
 assert.equal(report.summary.invalidEvidence,1);
 assert.deepEqual(report.summary.totals.actualCostMicrosByCurrency,{});
});

test("keeps currencies separate and rejects duplicate task rows",()=>{
 const eurApproval={...approval,id:"approval-02",currency:"EUR"};
 const eurTask={...task,id:"task-02",approval_id:"approval-02",currency:"EUR",estimated_cost_micros:100};
 const eurEvidence={...evidence,task_id:"task-02",currency:"EUR",actual_cost_micros:100,estimated_cost_micros:100,variance_micros:0};
 const report=buildProviderCostReconciliationReport({approvals:[approval,eurApproval],tasks:[task,eurTask],evidence:[evidence,eurEvidence]});
 assert.equal(report.summary.totals.actualCostMicrosByCurrency.USD,3500000);
 assert.equal(report.summary.totals.actualCostMicrosByCurrency.EUR,100);
 assert.throws(()=>buildProviderCostReconciliationReport({approvals:[approval],tasks:[task,task],evidence:[]}),{code:"PROVIDER_COST_REPORT_DUPLICATE_TASK"});
});

test("marks in-flight tasks pending rather than missing provider evidence",()=>{
 const pending={...task,state:"processing"};
 const report=buildProviderCostReconciliationReport({approvals:[approval],tasks:[pending],evidence:[]});
 assert.equal(report.status,"incomplete");
 assert.equal(report.summary.pendingTasks,1);
 assert.equal(report.summary.missingEvidence,0);
 assert.equal(report.items[0].evidenceStatus,"pending");
});

test("returns no_data when no generation tasks exist",()=>{
 const report=buildProviderCostReconciliationReport({approvals:[],tasks:[],evidence:[]});
 assert.equal(report.status,"no_data");
 assert.equal(report.summary.tasks,0);
});

test("supports personal approvals with no project and task rows scoped only through approval",()=>{
 const personalApproval={...approval,project_id:null};
 const personalTask={...task,owner_id:undefined,project_id:undefined};
 const report=buildProviderCostReconciliationReport({approvals:[personalApproval],tasks:[personalTask],evidence:[evidence]});
 assert.equal(report.status,"complete_provider_outcomes");
 assert.equal(report.items[0].ownerId,"owner-01");
 assert.equal(report.items[0].projectId,null);
});
