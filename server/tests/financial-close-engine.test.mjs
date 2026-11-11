import test from "node:test";
import assert from "node:assert/strict";
import {prepareFinancialCloseCommand} from "../financial-close-engine.mjs";

const assignee="11111111-1111-4111-8111-111111111111";
const reviewerA="22222222-2222-4222-8222-222222222222";
const reviewerB="33333333-3333-4333-8333-333333333333";
const task="44444444-4444-4444-8444-444444444444";
const at="2026-11-12T12:00:00.000Z";

test("period creation validates accounting period and currency",()=>{
 const result=prepareFinancialCloseCommand({action:"period.open",period:"2026-10",payload:{currency:"ugx",label:"October close"}});
 assert.equal(result.eventType,"close_period.created");
 assert.equal(result.payload.currency,"UGX");
 assert.equal(result.payload.period,"2026-10");
 assert.throws(()=>prepareFinancialCloseCommand({action:"period.open",period:"2026-13",payload:{currency:"UGX"}}),{code:"FINANCIAL_CLOSE_PERIOD_INVALID"});
 assert.throws(()=>prepareFinancialCloseCommand({action:"period.open",period:"2026-10",payload:{currency:"US"}}),{code:"FINANCIAL_CLOSE_CURRENCY_INVALID"});
});

test("task creation requires a distinct assignee and ordered independent approvers",()=>{
 const result=prepareFinancialCloseCommand({action:"task.create",period:"2026-10",payload:{
  taskId:task,title:"Bank reconciliation",assignedTo:assignee,approverIds:[reviewerA,reviewerB],dueAt:at,dependencies:[]
 }});
 assert.equal(result.eventType,"close_task.assigned");
 assert.deepEqual(result.payload.approverIds,[reviewerA,reviewerB]);
 assert.throws(()=>prepareFinancialCloseCommand({action:"task.create",period:"2026-10",payload:{
  taskId:task,title:"Bad self approval",assignedTo:assignee,approverIds:[assignee]
 }}),{code:"FINANCIAL_CLOSE_SELF_APPROVAL"});
});

test("task submission requires evidence references and task identifiers",()=>{
 assert.throws(()=>prepareFinancialCloseCommand({action:"task.submit",period:"2026-10",payload:{taskId:task}}),{code:"FINANCIAL_CLOSE_EVIDENCE_REQUIRED"});
 const result=prepareFinancialCloseCommand({action:"task.submit",period:"2026-10",payload:{taskId:task,evidenceRefs:["vault://evidence/statement-1"],completionNote:"Reconciled to statement"}});
 assert.equal(result.eventType,"close_task.submitted");
 assert.equal(result.payload.evidenceRefs.length,1);
});

test("close actions map to immutable audit event taxonomy",()=>{
 const cases=[
  ["task.start","close_task.started"],
  ["task.approve","close_task.approved"],
  ["task.reject","close_task.rejected"],
  ["task.waive","close_task.waived"],
  ["period.submit","close_period.submitted"],
  ["period.approve","close_period.approved"],
  ["period.lock","close_period.locked"],
  ["period.reopen","close_period.reopened"]
 ];
 for(const [action,eventType] of cases){
  const payload=action.startsWith("task.")?{taskId:task,...(["task.reject","task.waive"].includes(action)?{reason:"Reviewed exception"}:{})}:action==="period.reopen"?{reason:"Correcting approved source records"}:{};
  assert.equal(prepareFinancialCloseCommand({action,period:"2026-10",payload}).eventType,eventType);
 }
 assert.throws(()=>prepareFinancialCloseCommand({action:"period.delete",period:"2026-10"}),{code:"FINANCIAL_CLOSE_ACTION_INVALID"});
});

test("approval order, evidence, reason and idempotency constraints are normalized",()=>{
 assert.throws(()=>prepareFinancialCloseCommand({action:"task.assign",period:"2026-10",payload:{taskId:task,assignedTo:assignee,approverIds:[]}}),{code:"FINANCIAL_CLOSE_APPROVERS_INVALID"});
 assert.throws(()=>prepareFinancialCloseCommand({action:"task.waive",period:"2026-10",payload:{taskId:task,reason:""}}),{code:"FINANCIAL_CLOSE_INPUT_INVALID"});
 assert.throws(()=>prepareFinancialCloseCommand({action:"period.reopen",period:"2026-10",payload:{reason:""}}),{code:"FINANCIAL_CLOSE_INPUT_INVALID"});
});
