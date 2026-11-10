import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../db.mjs";
import { createControlRemediationApi } from "../control-remediation-api.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const editor="223e4567-e89b-42d3-a456-426614174000";
const reviewer="323e4567-e89b-42d3-a456-426614174000";
const outsider="523e4567-e89b-42d3-a456-426614174000";
const viewer="623e4567-e89b-42d3-a456-426614174000";
const project="423e4567-e89b-42d3-a456-426614174000";
const evidenceAsset1="723e4567-e89b-42d3-a456-426614174001";
const evidenceAsset2="723e4567-e89b-42d3-a456-426614174002";
const evidenceAsset3="723e4567-e89b-42d3-a456-426614174003";
function seedEvidenceAsset(db,{id=evidenceAsset1,ownerId=editor,projectId=project,mediaType="application/pdf",name="workpaper.pdf",sha256="a".repeat(64),byteSize=1024}={}){
 db.prepare("INSERT INTO assets(id,owner_id,project_id,original_name,media_type,byte_size,sha256,storage_path,metadata_json) VALUES(?,?,?,?,?,?,?,?,?)").run(id,ownerId,projectId,name,mediaType,byteSize,sha256,"uploads/"+id+".pdf","{}");
 return id;
}
function setup(){
 const db=openDatabase(":memory:");
 for(const [id,email] of [[owner,"owner@example.test"],[editor,"editor@example.test"],[reviewer,"reviewer@example.test"],[outsider,"outsider@example.test"],[viewer,"viewer@example.test"]])db.prepare("INSERT INTO users(id,email) VALUES(?,?)").run(id,email);
 db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run(project,owner,"Finance assurance");
 db.prepare("INSERT INTO project_members(project_id,member_id,role,invited_by) VALUES(?,?,?,?)").run(project,editor,"editor",owner);
 db.prepare("INSERT INTO project_members(project_id,member_id,role,invited_by) VALUES(?,?,?,?)").run(project,reviewer,"reviewer",owner);
 db.prepare("INSERT INTO project_members(project_id,member_id,role,invited_by) VALUES(?,?,?,?)").run(project,viewer,"viewer",owner);
 return {db,api:createControlRemediationApi({db})};
}
const createBody={projectId:project,findingId:"bank-reconciliation-gap",controlId:"CTRL-REC-01",title:"Resolve unmatched bank settlements",severity:"high",ownerId:editor,reviewerId:reviewer,dueAt:"2026-12-01T00:00:00.000Z",actionPlan:"Reconcile bank statement against the settlement ledger."};
test("persistent register creates project-scoped actions with independent owner and reviewer",async()=>{
 const f=setup();
 const result=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:createBody});
 assert.equal(result.status,201);
 assert.equal(result.body.action.ownerId,editor);
 assert.equal(result.body.action.reviewerId,reviewer);
 assert.equal(result.body.action.status,"open");
 assert.equal(result.body.action.revision,1);
 const list=await f.api.handle({method:"GET",path:"/api/finance/remediations",ownerId:reviewer,query:{projectId:project}});
 assert.equal(list.status,200);assert.equal(list.body.total,1);
 assert.equal((await f.api.handle({method:"GET",path:"/api/finance/remediations",ownerId:outsider,query:{projectId:project}})).status,404);
 const editorCreated=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:editor,body:{...createBody,findingId:"editor-created-finding"}});
 assert.equal(editorCreated.status,201);
 assert.equal((await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:createBody})).status,409);
 assert.equal((await f.api.handle({method:"GET",path:"/api/finance/remediations/"+editorCreated.body.action.id,ownerId:owner})).status,200);
 f.db.close();
});
test("personal remediation records default to the authenticated creator as accountable owner",async()=>{
 const f=setup();
 const body={...createBody,projectId:undefined,ownerId:undefined,reviewerId:undefined,findingId:"personal-finding"};
 delete body.projectId;delete body.ownerId;delete body.reviewerId;
 const result=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body});
 assert.equal(result.status,201);
 assert.equal(result.body.action.ownerId,owner);
 assert.equal(result.body.action.status,"open");
 f.db.close();
});
test("evidence, owner transition and independent reviewer verification persist with audit history",async()=>{
 const f=setup();
 const created=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:createBody});
 const id=created.body.action.id,assetId=seedEvidenceAsset(f.db);
 const evidence=await f.api.handle({method:"POST",path:"/api/finance/remediations/"+id+"/evidence",ownerId:editor,body:{label:"Bank reconciliation workpaper",kind:"workpaper",capturedAt:"2026-11-10T12:00:00.000Z",assetId}});
 assert.equal(evidence.status,201);assert.equal(evidence.body.action.evidence.length,1);
 assert.equal((await f.api.handle({method:"POST",path:"/api/finance/remediations/"+id+"/transitions",ownerId:editor,body:{to:"in_progress"}})).status,200);
 assert.equal((await f.api.handle({method:"POST",path:"/api/finance/remediations/"+id+"/transitions",ownerId:editor,body:{to:"pending_review"}})).status,200);
 assert.equal((await f.api.handle({method:"POST",path:"/api/finance/remediations/"+id+"/transitions",ownerId:editor,body:{to:"verified"}})).status,403);
 const verified=await f.api.handle({method:"POST",path:"/api/finance/remediations/"+id+"/transitions",ownerId:reviewer,body:{to:"verified",note:"Evidence independently reviewed."}});
 assert.equal(verified.status,200);assert.equal(verified.body.action.status,"verified");
 assert.equal(verified.body.action.verifiedBy,reviewer);
 assert.equal(verified.body.action.history.length,5);
 f.db.close();
});
test("review submission is blocked until a distinct reviewer is assigned",async()=>{
 const f=setup(),body={...createBody,findingId:"reviewer-required"};
 delete body.reviewerId;
 const created=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body});
 assert.equal(created.status,201);
 const id=created.body.action.id,route="/api/finance/remediations/"+id,assetId=seedEvidenceAsset(f.db,{id:evidenceAsset2});
 assert.equal((await f.api.handle({method:"POST",path:route+"/evidence",ownerId:editor,body:{label:"Control workpaper",kind:"workpaper",capturedAt:"2026-11-10T12:00:00.000Z",assetId}})).status,201);
 assert.equal((await f.api.handle({method:"POST",path:route+"/transitions",ownerId:editor,body:{to:"in_progress"}})).status,200);
 const blocked=await f.api.handle({method:"POST",path:route+"/transitions",ownerId:editor,body:{to:"pending_review"}});
 assert.equal(blocked.status,409);
 assert.equal(blocked.body.error.code,"REVIEWER_NOT_ASSIGNED");
 f.db.close();
});
test("only the assigned reviewer or project owner can return submitted work with a review note",async()=>{
 const f=setup();
 const created=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:createBody});
 const id=created.body.action.id,assetId=seedEvidenceAsset(f.db,{id:evidenceAsset3});
 const evidence=await f.api.handle({method:"POST",path:"/api/finance/remediations/"+id+"/evidence",ownerId:editor,body:{label:"Reconciliation workpaper",kind:"workpaper",capturedAt:"2026-11-10T12:00:00.000Z",assetId}});
 assert.equal(evidence.status,201);
 assert.equal((await f.api.handle({method:"POST",path:"/api/finance/remediations/"+id+"/transitions",ownerId:editor,body:{to:"in_progress"}})).status,200);
 assert.equal((await f.api.handle({method:"POST",path:"/api/finance/remediations/"+id+"/transitions",ownerId:editor,body:{to:"pending_review"}})).status,200);
 const route="/api/finance/remediations/"+id+"/transitions";
 assert.equal((await f.api.handle({method:"POST",path:route,ownerId:viewer,body:{to:"in_progress",note:"Please correct the workpaper."}})).status,403);
 assert.equal((await f.api.handle({method:"POST",path:route,ownerId:editor,body:{to:"in_progress",note:"Please correct the workpaper."}})).status,403);
 assert.equal((await f.api.handle({method:"POST",path:route,ownerId:reviewer,body:{to:"in_progress"}})).status,400);
 const returned=await f.api.handle({method:"POST",path:route,ownerId:reviewer,body:{to:"in_progress",note:"Reconcile the two unmatched settlement rows and attach the updated statement."}});
 assert.equal(returned.status,200);
 assert.equal(returned.body.action.status,"in_progress");
 assert.equal(returned.body.action.history.at(-1).event,"review_changes_requested");
 assert.match(returned.body.action.history.at(-1).note,/unmatched settlement rows/);
 f.db.close();
});
test("evidence attachment accepts only the uploader's matching project asset and derives its SHA-256 server-side",async()=>{
 const f=setup(),created=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:createBody}),id=created.body.action.id,route="/api/finance/remediations/"+id+"/evidence";
 const otherProject="823e4567-e89b-42d3-a456-426614174000";
 f.db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run(otherProject,owner,"Other project");
 const wrongScope=seedEvidenceAsset(f.db,{id:"823e4567-e89b-42d3-a456-426614174001",projectId:otherProject});
 const wrongOwner=seedEvidenceAsset(f.db,{id:"823e4567-e89b-42d3-a456-426614174002",ownerId:owner});
 const wrongType=seedEvidenceAsset(f.db,{id:"823e4567-e89b-42d3-a456-426614174003",mediaType:"application/json",name:"payload.exe"});
 const tooLarge=seedEvidenceAsset(f.db,{id:"823e4567-e89b-42d3-a456-426614174004",byteSize:10*1024*1024+1});
 for(const assetId of [wrongScope,wrongOwner])assert.equal((await f.api.handle({method:"POST",path:route,ownerId:editor,body:{label:"Wrong scope",kind:"workpaper",capturedAt:"2026-11-10",assetId}})).status,404);
 for(const assetId of [wrongType,tooLarge])assert.equal((await f.api.handle({method:"POST",path:route,ownerId:editor,body:{label:"Unsafe file",kind:"workpaper",capturedAt:"2026-11-10",assetId}})).status,415);
 const good=seedEvidenceAsset(f.db,{id:"923e4567-e89b-42d3-a456-426614174001",sha256:"b".repeat(64)});
 const attached=await f.api.handle({method:"POST",path:route,ownerId:editor,body:{label:"Verified bytes",kind:"workpaper",capturedAt:"2026-11-10",assetId:good,sha256:"c".repeat(64),uri:"https://attacker.example/file"}});
 assert.equal(attached.status,201);
 assert.equal(attached.body.action.evidence[0].sha256,"b".repeat(64));
 assert.equal(attached.body.action.evidence[0].uri,"asset://"+good);
 assert.equal(attached.body.action.evidence[0].assetId,good);
 assert.equal(attached.body.action.evidence[0].scanStatus,"not_scanned");
 assert.equal(attached.body.action.revision,2);
 f.db.close();
});
test("optimistic revision, duplicate findings and invalid evidence fail safely",async()=>{
 const f=setup();
 const created=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:createBody});
 const id=created.body.action.id;
 assert.equal((await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:createBody})).status,409);
 assert.equal((await f.api.handle({method:"PATCH",path:"/api/finance/remediations/"+id,ownerId:owner,body:{expectedRevision:9,actionPlan:"stale"}})).status,409);
 assert.equal((await f.api.handle({method:"POST",path:"/api/finance/remediations/"+id+"/evidence",ownerId:outsider,body:{label:"No access",kind:"other",capturedAt:"2026-11-10"}})).status,404);
 assert.equal((await f.api.handle({method:"POST",path:"/api/finance/remediations/"+id+"/evidence",ownerId:editor,body:{label:"Unattached metadata",kind:"other",capturedAt:"2026-11-10",sha256:"a".repeat(64)}})).status,400);
 f.db.close();
});
test("API ignores unrelated routes and rejects malformed owner identities",async()=>{
 const f=setup();
 assert.equal(await f.api.handle({method:"GET",path:"/api/other",ownerId:owner}),null);
 assert.equal((await f.api.handle({method:"GET",path:"/api/finance/remediations",ownerId:"not-a-user"})).status,401);
 f.db.close();
});


test("evidence download audit records successful authorized access and exposes a bounded reviewer trail",async()=>{
 const f=setup(),created=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:createBody}),id=created.body.action.id,assetId=seedEvidenceAsset(f.db,{id:"a23e4567-e89b-42d3-a456-426614174001"});
 const attached=await f.api.handle({method:"POST",path:"/api/finance/remediations/"+id+"/evidence",ownerId:editor,body:{label:"Signed reconciliation",kind:"workpaper",capturedAt:"2026-11-10",assetId}});
 assert.equal(attached.status,201);
 assert.equal(f.api.recordEvidenceDownload({ownerId:outsider,assetId}),0);
 assert.equal(f.api.recordEvidenceDownload({ownerId:reviewer,assetId}),1);
 assert.equal(f.api.recordEvidenceDownload({ownerId:viewer,assetId}),1);
 assert.equal(f.api.recordEvidenceDownload({ownerId:editor,assetId}),1);
 const read=await f.api.handle({method:"GET",path:"/api/finance/remediations/"+id,ownerId:reviewer});
 assert.equal(read.status,200);
 assert.equal(read.body.action.evidenceDownloads.length,3);
 assert.deepEqual(read.body.action.evidenceDownloads.map(x=>x.actorId),[editor,viewer,reviewer]);
 assert.equal(read.body.action.evidenceDownloads[0].details.evidenceId,attached.body.action.evidence[0].id);
 assert.equal(read.body.action.evidenceDownloads[0].details.assetId,assetId);
 assert.equal(read.body.action.evidenceDownloads[0].details.label,"Signed reconciliation");
 const auditCount=f.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type='control_remediation.evidence_downloaded'").get().count;
 assert.equal(auditCount,3);
 f.db.close();
});
test("personal evidence download audit is visible only to the personal record owner",async()=>{
 const f=setup(),body={...createBody,findingId:"personal-download-audit"};
 delete body.projectId;delete body.ownerId;delete body.reviewerId;
 const created=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body});
 const assetId=seedEvidenceAsset(f.db,{id:"b23e4567-e89b-42d3-a456-426614174001",ownerId:owner,projectId:null});
 const id=created.body.action.id;
 assert.equal((await f.api.handle({method:"POST",path:"/api/finance/remediations/"+id+"/evidence",ownerId:owner,body:{label:"Personal workpaper",kind:"workpaper",capturedAt:"2026-11-10",assetId}})).status,201);
 assert.equal(f.api.recordEvidenceDownload({ownerId:editor,assetId}),0);
 assert.equal(f.api.recordEvidenceDownload({ownerId:owner,assetId}),1);
 const read=await f.api.handle({method:"GET",path:"/api/finance/remediations/"+id,ownerId:owner});
 assert.equal(read.body.action.evidenceDownloads.length,1);
 assert.equal(read.body.action.evidenceDownloads[0].actorId,owner);
 f.db.close();
});


test("reviewer inbox is assigned-reviewer scoped and returns server-derived SLA buckets",async()=>{
 const f=setup(),now=Date.now();
 const overdue=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:{...createBody,findingId:"review-inbox-overdue",dueAt:new Date(now-86400000).toISOString()}});
 const soon=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:{...createBody,findingId:"review-inbox-soon",dueAt:new Date(now+24*60*60*1000).toISOString()}});
 const later=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:{...createBody,findingId:"review-inbox-later",dueAt:new Date(now+10*24*60*60*1000).toISOString()}});
 assert.equal(overdue.status,201);assert.equal(soon.status,201);assert.equal(later.status,201);
 const inbox=await f.api.handle({method:"GET",path:"/api/finance/remediations/inbox",ownerId:reviewer});
 assert.equal(inbox.status,200);
 assert.equal(inbox.body.actions.length,3);
 assert.deepEqual(new Set(inbox.body.actions.map(x=>x.slaState)),new Set(["overdue","due_soon","on_track"]));
 assert.equal(inbox.body.counts.total,3);
 assert.equal(inbox.body.counts.overdue,1);
 assert.equal(inbox.body.counts.dueSoon,1);
 assert.equal(inbox.body.counts.onTrack,1);
 assert.equal(inbox.body.policy.dueSoonHours,72);
 assert.equal(inbox.body.policy.escalation.includes("no automatic"),true);
 assert.equal((await f.api.handle({method:"GET",path:"/api/finance/remediations/inbox",ownerId:editor})).body.counts.total,0);
 assert.equal((await f.api.handle({method:"GET",path:"/api/finance/remediations/inbox",ownerId:owner})).body.counts.total,0);
 assert.equal((await f.api.handle({method:"GET",path:"/api/finance/remediations/inbox",ownerId:outsider})).body.counts.total,0);
 assert.equal((await f.api.handle({method:"GET",path:"/api/finance/remediations/inbox",ownerId:reviewer,query:{status:"pending_review"}})).body.actions.length,0);
 assert.equal((await f.api.handle({method:"GET",path:"/api/finance/remediations/inbox",ownerId:reviewer,query:{projectId:"invalid"}})).status,400);
 f.db.close();
});
test("reviewer inbox excludes archived or removed project memberships",async()=>{
 const f=setup(),created=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:{...createBody,findingId:"review-inbox-membership"}});
 assert.equal(created.status,201);
 f.db.prepare("DELETE FROM project_members WHERE project_id=? AND member_id=?").run(project,reviewer);
 const inbox=await f.api.handle({method:"GET",path:"/api/finance/remediations/inbox",ownerId:reviewer});
 assert.equal(inbox.status,200);assert.equal(inbox.body.counts.total,0);
 f.db.close();
});


test("audit export is access-scoped and its SHA-256 manifest detects payload changes",async()=>{
 const {createHash}=await import("node:crypto");
 const {verifyAuditExport}=await import("../../scripts/verify-remediation-audit-export.mjs");
 const f=setup(),created=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:createBody});
 const id=created.body.action.id,assetId=seedEvidenceAsset(f.db,{id:"c23e4567-e89b-42d3-a456-426614174001"});
 assert.equal((await f.api.handle({method:"POST",path:"/api/finance/remediations/"+id+"/evidence",ownerId:editor,body:{label:"Export evidence",kind:"workpaper",capturedAt:"2026-11-10",assetId}})).status,201);
 assert.equal(f.api.recordEvidenceDownload({ownerId:reviewer,assetId}),1);
 const denied=await f.api.handle({method:"GET",path:"/api/finance/remediations/"+id+"/audit-export",ownerId:outsider});
 assert.equal(denied.status,404);
 const exported=await f.api.handle({method:"GET",path:"/api/finance/remediations/"+id+"/audit-export",ownerId:reviewer});
 assert.equal(exported.status,200);
 assert.equal(exported.body.integrity.algorithm,"SHA-256");
 assert.equal(exported.body.integrity.auditEventCount,3);
 assert.equal(exported.body.integrity.historyCount,2);
 const digest=createHash("sha256").update(JSON.stringify(exported.body.payload),"utf8").digest("hex");
 assert.equal(exported.body.integrity.sha256,digest);
 assert.equal(verifyAuditExport(exported.body).valid,true);
 const altered=structuredClone(exported.body);altered.payload.history[0].note="tampered";
 assert.equal(verifyAuditExport(altered).valid,false);
 const countAltered=structuredClone(exported.body);countAltered.integrity.auditEventCount+=1;
 assert.equal(verifyAuditExport(countAltered).valid,false);
 f.db.close();
});


test("executive assurance summary is access-scoped and reports portfolio exposure without archived or foreign records",async()=>{
 const f=setup();
 const first=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:{...createBody,findingId:"assurance-overdue",dueAt:"2026-11-01T00:00:00.000Z"}});
 assert.equal(first.status,201);
 const assetId=seedEvidenceAsset(f.db,{id:"a23e4567-e89b-42d3-a456-426614174001"});
 assert.equal((await f.api.handle({method:"POST",path:"/api/finance/remediations/"+first.body.action.id+"/evidence",ownerId:editor,body:{label:"Reconciliation evidence",kind:"workpaper",capturedAt:"2026-11-10",assetId}})).status,201);
 const second=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:{...createBody,findingId:"assurance-critical",severity:"critical",reviewerId:undefined,dueAt:"2026-11-11T00:00:00.000Z"}});
 assert.equal(second.status,201);
 const personalBody={...createBody,findingId:"assurance-personal"};delete personalBody.projectId;delete personalBody.ownerId;delete personalBody.reviewerId;
 assert.equal((await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:personalBody})).status,201);
 const archivedProject="b23e4567-e89b-42d3-a456-426614174000";
 f.db.prepare("INSERT INTO projects(id,owner_id,name) VALUES(?,?,?)").run(archivedProject,owner,"Archived project");
 const archivedAction=await f.api.handle({method:"POST",path:"/api/finance/remediations",ownerId:owner,body:{...createBody,projectId:archivedProject,ownerId:owner,reviewerId:undefined,findingId:"assurance-archived"}});
 assert.equal(archivedAction.status,201);
 f.db.prepare("UPDATE projects SET archived_at=? WHERE id=?").run("2026-11-10T00:00:00.000Z",archivedProject);
 const ownerView=await f.api.handle({method:"GET",path:"/api/finance/remediations/assurance",ownerId:owner});
 assert.equal(ownerView.status,200);
 assert.equal(ownerView.body.totals.total,3);
 assert.equal(ownerView.body.totals.open,3);
 assert.equal(ownerView.body.totals.criticalOpen,1);
 assert.equal(ownerView.body.totals.highOpen,1);
 assert.equal(ownerView.body.totals.overdue,1);
 assert.equal(ownerView.body.totals.withoutEvidence,2);
 assert.equal(ownerView.body.coverage.evidenceCoveragePct,33);
 assert.equal(ownerView.body.byProject.length,2);
 const reviewerView=await f.api.handle({method:"GET",path:"/api/finance/remediations/assurance",ownerId:reviewer});
 assert.equal(reviewerView.body.totals.total,2);
 const outsiderView=await f.api.handle({method:"GET",path:"/api/finance/remediations/assurance",ownerId:outsider});
 assert.equal(outsiderView.body.totals.total,0);
 assert.equal(outsiderView.body.priorityItems.length,0);
 assert.equal(ownerView.body.priorityItems.some(x=>x.findingId==="assurance-personal"),true);
 assert.equal(reviewerView.body.priorityItems.some(x=>x.findingId==="assurance-personal"),false);
 f.db.close();
});
