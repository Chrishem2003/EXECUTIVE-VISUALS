import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db.mjs";
import { createRunwayRouterApprovalLedger } from "../runway-router-approval-ledger.mjs";

const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const reviewerId = "423e4567-e89b-42d3-a456-426614174000";
const workerId = "523e4567-e89b-42d3-a456-426614174000";
const projectId = "223e4567-e89b-42d3-a456-426614174000";
const hash = "a".repeat(64);
const decision = {
  status: "preflighted", dryRun: true, taskCreated: false, billed: false,
  configId: "creative_low_cost", provider: "bytedance", model: "seedance2_5",
  estimatedCredits: 240, inputHash: hash, budgetCheck: "within_limit"
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ev-runway-approval-"));
  const db = openDatabase(join(root, "jobs.sqlite"));
  for (const [id,email] of [[ownerId,"owner@example.test"],[reviewerId,"reviewer@example.test"],[workerId,"worker@example.test"]]) {
    db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run(id,email);
  }
  db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run(projectId,ownerId,"Approval test project");
  let clock = new Date("2026-11-05T06:00:00.000Z");
  const allowed = (scope, actorId) => scope.ownerId === ownerId && scope.projectId === projectId &&
    [ownerId,reviewerId,workerId].includes(actorId);
  const ledger = createRunwayRouterApprovalLedger({
    db, now: () => new Date(clock),
    authorizeProject: scope => allowed(scope,scope.actorId) && [ownerId,reviewerId].includes(scope.actorId),
    authorizeApproval: scope => allowed(scope,scope.actorId) && scope.actorId === reviewerId,
    authorizeExecution: scope => allowed(scope,scope.actorId) && scope.actorId === workerId
  });
  return {root,db,ledger,setNow:value=>{clock=new Date(value);}};
}
function create(f) {
  return f.ledger.recordPreflight({ownerId,projectId,actorId:ownerId,decision,maxEstimatedCredits:250});
}

test("records only successful dry-run decisions within a bounded credit ceiling", async () => {
  const f=await fixture();
  try {
    const row=create(f);
    assert.equal(row.state,"pending_approval");
    assert.equal(row.estimatedCredits,240);
    assert.equal(row.maxEstimatedCredits,250);
    assert.equal(row.inputHash,hash);
    assert.equal(row.metadata && Object.keys(row.metadata).length,0);
    for (const bad of [
      {...decision,dryRun:false},
      {...decision,taskCreated:true},
      {...decision,billed:true},
      {...decision,budgetCheck:"not_checked"},
      {...decision,inputHash:"bad"},
      {...decision,estimatedCredits:251}
    ]) assert.throws(()=>f.ledger.recordPreflight({ownerId,projectId,actorId:ownerId,decision:bad,maxEstimatedCredits:250}));
    assert.throws(()=>f.ledger.recordPreflight({ownerId,projectId,actorId:ownerId,decision,maxEstimatedCredits:239}),e=>e.code==="RUNWAY_APPROVAL_BUDGET_INVALID");
    assert.throws(()=>f.ledger.recordPreflight({ownerId,projectId,actorId:reviewerId,decision,maxEstimatedCredits:250}),e=>e.code==="RUNWAY_APPROVAL_PROJECT_FORBIDDEN");
  } finally {f.db.close();await rm(f.root,{recursive:true,force:true});}
});

test("approval requires authorized reviewer and exact preflight fingerprint", async () => {
  const f=await fixture();
  try {
    const row=create(f);
    assert.throws(()=>f.ledger.approve({approvalId:row.id,ownerId,projectId,actorId:ownerId,inputHash:hash}),e=>e.code==="RUNWAY_APPROVAL_ACTOR_FORBIDDEN");
    assert.throws(()=>f.ledger.approve({approvalId:row.id,ownerId,projectId,actorId:reviewerId,inputHash:"b".repeat(64)}),e=>e.code==="RUNWAY_APPROVAL_HASH_MISMATCH");
    const approved=f.ledger.approve({approvalId:row.id,ownerId,projectId,actorId:reviewerId,inputHash:hash});
    assert.equal(approved.state,"approved");
    assert.equal(approved.approvedBy,reviewerId);
    assert.throws(()=>f.ledger.approve({approvalId:row.id,ownerId,projectId,actorId:reviewerId,inputHash:hash}),e=>e.code==="RUNWAY_APPROVAL_STATE_INVALID");
  } finally {f.db.close();await rm(f.root,{recursive:true,force:true});}
});

test("execution consumes an approved fingerprint exactly once and rejects changed requests", async () => {
  const f=await fixture();
  try {
    const row=create(f);
    f.ledger.approve({approvalId:row.id,ownerId,projectId,actorId:reviewerId,inputHash:hash});
    assert.throws(()=>f.ledger.consume({approvalId:row.id,ownerId,projectId,actorId:workerId,inputHash:"b".repeat(64)}),e=>e.code==="RUNWAY_APPROVAL_HASH_MISMATCH");
    const consumed=f.ledger.consume({approvalId:row.id,ownerId,projectId,actorId:workerId,inputHash:hash});
    assert.equal(consumed.state,"consumed");
    assert.equal(consumed.consumedBy,workerId);
    assert.throws(()=>f.ledger.consume({approvalId:row.id,ownerId,projectId,actorId:workerId,inputHash:hash}),e=>e.code==="RUNWAY_APPROVAL_STATE_INVALID");
  } finally {f.db.close();await rm(f.root,{recursive:true,force:true});}
});

test("expired approvals cannot be approved or consumed", async () => {
  const f=await fixture();
  try {
    const pending=create(f);
    f.setNow("2026-11-05T06:16:00.000Z");
    assert.throws(()=>f.ledger.approve({approvalId:pending.id,ownerId,projectId,actorId:reviewerId,inputHash:hash}),e=>e.code==="RUNWAY_APPROVAL_EXPIRED");
    assert.equal(f.ledger.get(pending.id).state,"expired");
    f.setNow("2026-11-05T06:00:00.000Z");
    const approved=create(f);
    f.ledger.approve({approvalId:approved.id,ownerId,projectId,actorId:reviewerId,inputHash:hash});
    f.setNow("2026-11-05T06:16:00.000Z");
    assert.throws(()=>f.ledger.consume({approvalId:approved.id,ownerId,projectId,actorId:workerId,inputHash:hash}),e=>e.code==="RUNWAY_APPROVAL_EXPIRED");
    assert.equal(f.ledger.get(approved.id).state,"expired");
  } finally {f.db.close();await rm(f.root,{recursive:true,force:true});}
});

test("approval can be revoked but cannot be consumed or revoked twice", async () => {
  const f=await fixture();
  try {
    const row=create(f);
    f.ledger.approve({approvalId:row.id,ownerId,projectId,actorId:reviewerId,inputHash:hash});
    const revoked=f.ledger.revoke({approvalId:row.id,ownerId,projectId,actorId:reviewerId});
    assert.equal(revoked.state,"revoked");
    assert.throws(()=>f.ledger.consume({approvalId:row.id,ownerId,projectId,actorId:workerId,inputHash:hash}),e=>e.code==="RUNWAY_APPROVAL_STATE_INVALID");
    assert.throws(()=>f.ledger.revoke({approvalId:row.id,ownerId,projectId,actorId:reviewerId}),e=>e.code==="RUNWAY_APPROVAL_STATE_INVALID");
  } finally {f.db.close();await rm(f.root,{recursive:true,force:true});}
});

test("approval records are scoped to their owner and project and history is bounded", async () => {
  const f=await fixture();
  try {
    const row=create(f);
    assert.throws(()=>f.ledger.approve({approvalId:row.id,ownerId:reviewerId,projectId,actorId:reviewerId,inputHash:hash}),e=>e.code==="RUNWAY_APPROVAL_NOT_FOUND");
    assert.equal(f.ledger.listForProject({ownerId,projectId,limit:10}).length,1);
    assert.throws(()=>f.ledger.listForProject({ownerId,projectId,limit:201}));
  } finally {f.db.close();await rm(f.root,{recursive:true,force:true});}
});
