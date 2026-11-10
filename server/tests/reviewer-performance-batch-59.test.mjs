import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db.mjs";
import { createControlRemediationApi } from "../control-remediation-api.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const editor="223e4567-e89b-42d3-a456-426614174000";
const reviewer="323e4567-e89b-42d3-a456-426614174000";
const outsider="523e4567-e89b-42d3-a456-426614174000";
const project="423e4567-e89b-42d3-a456-426614174000";

function setup(){
 const db=openDatabase(":memory:");
 for(const [id,email] of [[owner,"owner@example.test"],[editor,"editor@example.test"],[reviewer,"reviewer@example.test"],[outsider,"outsider@example.test"]])db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run(id,email);
 db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run(project,owner,"Reviewer performance");
 db.prepare("INSERT INTO project_members(project_id,member_id,role,invited_by) VALUES(?,?,?,?)").run(project,editor,"editor",owner);
 db.prepare("INSERT INTO project_members(project_id,member_id,role,invited_by) VALUES(?,?,?,?)").run(project,reviewer,"reviewer",owner);
 return {db,api:createControlRemediationApi({db})};
}

const body=(findingId,dueAt="2026-12-01T00:00:00.000Z")=>({projectId:project,findingId,controlId:"CTRL-REV-01",title:"Review financial control evidence",severity:"high",ownerId:editor,reviewerId:reviewer,dueAt,actionPlan:"Review the evidence and record the decision."});

test("reviewer performance reports scoped workload and measured assigned-reviewer turnaround",async()=>{
 const f=setup();
 const completed=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:body("review-completed")});
 const pending=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:body("review-pending","2026-11-01T00:00:00.000Z")});
 assert.equal(completed.status,201);assert.equal(pending.status,201);
 const completedId=completed.body.action.id,pendingId=pending.body.action.id;
 f.db.prepare("UPDATE control_remediation_actions SET status='verified',verified_by=?,verified_at=? WHERE id=?").run(reviewer,"2026-11-10T12:00:00.000Z",completedId);
 f.db.prepare("INSERT INTO control_remediation_history(action_id,actor_id,event_type,from_status,to_status,created_at) VALUES(?,?,?,?,?,?)").run(completedId,editor,"status_transition","in_progress","pending_review","2026-11-10T08:00:00.000Z");
 f.db.prepare("INSERT INTO control_remediation_history(action_id,actor_id,event_type,from_status,to_status,created_at) VALUES(?,?,?,?,?,?)").run(completedId,reviewer,"status_transition","pending_review","verified","2026-11-10T12:00:00.000Z");
 f.db.prepare("UPDATE control_remediation_actions SET status='pending_review' WHERE id=?").run(pendingId);
 f.db.prepare("INSERT INTO control_remediation_history(action_id,actor_id,event_type,from_status,to_status,created_at) VALUES(?,?,?,?,?,?)").run(pendingId,editor,"status_transition","in_progress","pending_review","2026-11-10T09:00:00.000Z");

 const result=await f.api.handle({method:"GET",path:"/api/finance/remediations/reviewer-performance",ownerId});
 assert.equal(result.status,200);
 assert.equal(result.body.totals.assigned,2);
 assert.equal(result.body.totals.awaitingReview,1);
 assert.equal(result.body.totals.actionDeadlineOverdueAwaiting,1);
 assert.equal(result.body.totals.verifiedByAssignedReviewer,1);
 assert.equal(result.body.totals.measuredReviews,1);
 assert.equal(result.body.totals.portfolioMedianTurnaroundHours,4);
 assert.equal(result.body.reviewers.length,1);
 assert.equal(result.body.reviewers[0].medianTurnaroundHours,4);
 assert.equal(result.body.reviewers[0].medianCurrentPendingAgeHours>=0,true);
 assert.equal(result.body.byProject[0].awaitingReview,1);
 assert.equal(result.body.policy.slaConfigured,false);
 assert.equal(result.body.policy.deadline,"dueAt is the remediation action deadline, not a reviewer-specific SLA deadline.");
 assert.equal(JSON.stringify(result.body).includes("reviewer@example.test"),false);
 f.db.close();
});

test("reviewer performance excludes archived and inaccessible projects and returns opaque reviewer references",async()=>{
 const f=setup();
 await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:body("scoped-review")});
 const member=await f.api.handle({method:"GET",path:"/api/finance/remediations/reviewer-performance",ownerId:reviewer});
 assert.equal(member.body.totals.assigned,1);
 const outsiderResult=await f.api.handle({method:"GET",path:"/api/finance/remediations/reviewer-performance",ownerId:outsider});
 assert.equal(outsiderResult.status,200);
 assert.equal(outsiderResult.body.totals.assigned,0);
 f.db.prepare("UPDATE projects SET archived_at=? WHERE id=?").run("2026-11-10T00:00:00.000Z",project);
 const archived=await f.api.handle({method:"GET",path:"/api/finance/remediations/reviewer-performance",ownerId});
 assert.equal(archived.body.totals.assigned,0);
 f.db.close();
});
