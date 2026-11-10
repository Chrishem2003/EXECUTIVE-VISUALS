import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openDatabase } from "../db.mjs";
import { createControlRemediationApi } from "../control-remediation-api.mjs";
import { verifyFinanceAssuranceReport } from "../../scripts/verify-finance-assurance-report.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const editor="223e4567-e89b-42d3-a456-426614174000";
const reviewer="323e4567-e89b-42d3-a456-426614174000";
const outsider="523e4567-e89b-42d3-a456-426614174000";
const project="423e4567-e89b-42d3-a456-426614174000";
const asset="723e4567-e89b-42d3-a456-426614174001";

function setup(){
  const db=openDatabase(":memory:");
  for(const [id,email] of [[owner,"owner@example.test"],[editor,"editor@example.test"],[reviewer,"reviewer@example.test"],[outsider,"outsider@example.test"]]){
    db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run(id,email);
  }
  db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run(project,owner,"Assurance project");
  db.prepare("INSERT INTO project_members(project_id,member_id,role,invited_by) VALUES(?,?,?,?)").run(project,editor,"editor",owner);
  db.prepare("INSERT INTO project_members(project_id,member_id,role,invited_by) VALUES(?,?,?,?)").run(project,reviewer,"reviewer",owner);
  return {db,api:createControlRemediationApi({db})};
}

const projectAction={projectId:project,findingId:"report-project-finding",controlId:"CTRL-01",title:"Review settlement exceptions",severity:"high",ownerId:editor,reviewerId:reviewer,dueAt:"2026-12-01T00:00:00.000Z",actionPlan:"Review and document settlement exceptions."};

test("portfolio assurance report is access-scoped, complete, and independently verifiable",async()=>{
  const f=setup();
  const created=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:projectAction});
  assert.equal(created.status,201);
  f.db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(asset,editor,project,"settlement.pdf","application/pdf",1024,"a".repeat(64),"uploads/private.pdf","{}");
  assert.equal((await f.api.handle({method:"POST",path:"/api/finance/remediations/"+created.body.action.id+"/evidence",ownerId:editor,body:{label:"Settlement workpaper",kind:"workpaper",capturedAt:"2026-11-10",assetId:asset}})).status,201);
  const personal={...projectAction,findingId:"report-personal-finding"};
  delete personal.projectId;delete personal.ownerId;delete personal.reviewerId;
  assert.equal((await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:personal})).status,201);

  const report=await f.api.handle({method:"GET",path:"/api/finance/remediations/portfolio-report",ownerId:owner});
  assert.equal(report.status,200);
  assert.equal(report.body.payload.reportType,"executive-financial-assurance");
  assert.equal(report.body.payload.completeness.totalRecords,2);
  assert.equal(report.body.payload.completeness.truncated,false);
  assert.equal(report.body.payload.actions.length,2);
  assert.equal(report.body.integrity.signatureStatus,"unsigned-digest-only");
  assert.equal(verifyFinanceAssuranceReport(report.body).valid,true);
  const digest=createHash("sha256").update(JSON.stringify(report.body.payload),"utf8").digest("hex");
  assert.equal(report.body.integrity.sha256,digest);
  assert.equal(report.body.payload.actions.some(x=>x.evidence.some(e=>e.assetLinked===1)),true);
  assert.equal(JSON.stringify(report.body).includes("uploads/private.pdf"),false);
  assert.equal(JSON.stringify(report.body).includes("asset://"),false);

  const memberReport=await f.api.handle({method:"GET",path:"/api/finance/remediations/portfolio-report",ownerId:reviewer});
  assert.equal(memberReport.body.payload.completeness.totalRecords,1);
  assert.equal(memberReport.body.payload.actions.some(x=>x.findingId==="report-personal-finding"),false);
  const outsiderReport=await f.api.handle({method:"GET",path:"/api/finance/remediations/portfolio-report",ownerId:outsider});
  assert.equal(outsiderReport.body.payload.actions.length,0);
  assert.equal((await f.api.handle({method:"GET",path:"/api/finance/remediations/portfolio-report",ownerId:"not-an-account"})).status,401);
  f.db.close();
});

test("portfolio report verifier detects payload, manifest, and completeness tampering",async()=>{
  const f=setup();
  await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:projectAction});
  await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:{...projectAction,findingId:"second-report-finding"}});
  const truncated=await f.api.handle({method:"GET",path:"/api/finance/remediations/portfolio-report",ownerId:owner,query:{limit:"1"}});
  assert.equal(truncated.body.payload.completeness.recordsIncluded,1);
  assert.equal(truncated.body.payload.completeness.totalRecords,2);
  assert.equal(truncated.body.payload.completeness.truncated,true);
  assert.equal(verifyFinanceAssuranceReport(truncated.body).valid,true);
  const altered=structuredClone(truncated.body);
  altered.payload.actions[0].title="Changed after export";
  assert.equal(verifyFinanceAssuranceReport(altered).valid,false);
  const falseComplete=structuredClone(truncated.body);
  falseComplete.payload.completeness.truncated=false;
  assert.equal(verifyFinanceAssuranceReport(falseComplete).valid,false);
  const badCount=structuredClone(truncated.body);
  badCount.integrity.actionCount+=1;
  assert.equal(verifyFinanceAssuranceReport(badCount).valid,false);
  f.db.close();
});
