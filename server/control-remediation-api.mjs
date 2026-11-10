import { randomUUID } from "node:crypto";
import { audit, json, parseJson, getProjectAccess } from "./db.mjs";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const response=(status,body)=>({status,body});
const error=(status,code,message)=>response(status,{error:{code,message}});
const text=(value,max=500)=>typeof value==="string"?value.trim().slice(0,max):"";
const date=value=>{const n=Date.parse(String(value??""));return Number.isFinite(n)?new Date(n).toISOString():null;};
const transitions={unassigned:["open"],open:["in_progress"],in_progress:["pending_review","open"],pending_review:["verified","in_progress"],verified:["reopened"],reopened:["in_progress"]};
const statuses=new Set(Object.keys(transitions));
const evidenceKinds=new Set(["source","workpaper","approval","test","other"]);
const safeAction=row=>({
 id:row.id,projectId:row.project_id,findingId:row.finding_id,controlId:row.control_id,title:row.title,severity:row.severity,
 ownerId:row.assigned_owner_id,reviewerId:row.reviewer_id,dueAt:row.due_at,status:row.status,actionPlan:row.action_plan,
 verifiedAt:row.verified_at,verifiedBy:row.verified_by,reopenedCount:row.reopened_count,revision:row.revision,
 createdAt:row.created_at,updatedAt:row.updated_at
});

export function createControlRemediationApi({db}={}){
 if(!db)throw new Error("Control remediation API requires a database.");
 function access(ownerId,projectId,write=false){
  if(!projectId)return {owner_id:ownerId,access_role:"owner"};
  const found=getProjectAccess(db,ownerId,projectId);
  if(!found)return null;
  if(write&&!["owner","editor"].includes(found.access_role))return null;
  return found;
 }
 function actionFor(ownerId,id){
  return db.prepare("SELECT * FROM control_remediation_actions WHERE id=? AND (owner_id=? OR project_id IN (SELECT project_id FROM project_members WHERE member_id=?) OR project_id IN (SELECT id FROM projects WHERE owner_id=?))").get(id,ownerId,ownerId,ownerId);
 }
 function hydrate(row){
  return {...safeAction(row),evidence:db.prepare("SELECT id,label,evidence_uri AS uri,sha256,kind,captured_at AS capturedAt,submitted_by AS submittedBy,created_at AS createdAt FROM control_remediation_evidence WHERE action_id=? ORDER BY created_at,id").all(row.id),
   history:db.prepare("SELECT id,actor_id AS actorId,event_type AS event,from_status AS fromStatus,to_status AS toStatus,note,details_json,created_at AS at FROM control_remediation_history WHERE action_id=? ORDER BY id").all(row.id).map(x=>({...x,details:parseJson(x.details_json)}))};
 }
 function member(ownerId,projectId,memberId){
  if(!memberId)return null;
  if(!projectId)return memberId===ownerId?{access_role:"owner"}:null;
  return getProjectAccess(db,memberId,projectId);
 }
 function appendHistory(actionId,actorId,event,fromStatus,toStatus,note="",details={}){
  db.prepare("INSERT INTO control_remediation_history(action_id,actor_id,event_type,from_status,to_status,note,details_json) VALUES(?,?,?,?,?,?,?)")
   .run(actionId,actorId,event,fromStatus,toStatus,text(note,1000),json(details));
 }
 async function handle({method,path,ownerId,body={},query={}}){
  if(!path.startsWith("/api/finance/remediations"))return null;
  if(!UUID.test(String(ownerId||"")))return error(401,"AUTH_REQUIRED","A verified account is required.");
  if(path==="/api/finance/remediations"&&method==="GET"){
   const projectId=text(query.projectId,64)||null;
   if(projectId&&!UUID.test(projectId))return error(400,"INVALID_PROJECT","Project ID is invalid.");
   if(!access(ownerId,projectId,false))return error(404,"NOT_FOUND","Remediation register not found.");
   const rows=projectId
    ?db.prepare("SELECT * FROM control_remediation_actions WHERE project_id=? ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,due_at").all(projectId)
    :db.prepare("SELECT * FROM control_remediation_actions WHERE owner_id=? AND project_id IS NULL ORDER BY due_at").all(ownerId);
   return response(200,{actions:rows.map(hydrate),total:rows.length});
  }
  if(path==="/api/finance/remediations"&&method==="POST"){
   const projectId=text(body.projectId,64)||null;
   if(projectId&&!UUID.test(projectId))return error(400,"INVALID_PROJECT","Project ID is invalid.");
   if(!access(ownerId,projectId,true))return error(404,"NOT_FOUND","Writable project not found.");
   const findingId=text(body.findingId,160),controlId=text(body.controlId,120),title=text(body.title,240),severity=text(body.severity,24).toLowerCase();
   const dueAt=date(body.dueAt),actionPlan=text(body.actionPlan,4000);
   if(!findingId||!controlId||!title||!dueAt||!["critical","high","medium","low","unknown"].includes(severity))return error(400,"INVALID_REMEDIATION","Finding, control, title, supported severity and due date are required.");
   const assignedOwnerId=text(body.ownerId,64)||null,reviewerId=text(body.reviewerId,64)||null;
   for(const id of [assignedOwnerId,reviewerId])if(id&&!UUID.test(id))return error(400,"INVALID_ASSIGNMENT","Assignment must reference a valid account.");
   if(assignedOwnerId){const assignedAccess=member(ownerId,projectId,assignedOwnerId);if(!assignedAccess||!["owner","editor"].includes(assignedAccess.access_role))return error(400,"INVALID_OWNER","Assigned owner must have owner or editor access to this project.");}
   if(reviewerId){const reviewerAccess=member(ownerId,projectId,reviewerId);if(!reviewerAccess||!["owner","reviewer"].includes(reviewerAccess.access_role)||reviewerId===assignedOwnerId)return error(400,"INVALID_REVIEWER","Reviewer must be a distinct project owner or reviewer.");}
   const id=randomUUID(),status=assignedOwnerId?"open":"unassigned";
   try{
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO control_remediation_actions(id,owner_id,project_id,finding_id,control_id,title,severity,assigned_owner_id,reviewer_id,due_at,status,action_plan) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
     .run(id,ownerId,projectId,findingId,controlId,title,severity,assignedOwnerId,reviewerId,dueAt,status,actionPlan);
    appendHistory(id,ownerId,"created",null,status,"Remediation record created.");
    audit(db,ownerId,"control_remediation.created","control_remediation",id,{findingId,controlId,severity,status},projectId);
    db.exec("COMMIT");
   }catch(e){try{db.exec("ROLLBACK");}catch{}if(String(e.message).includes("UNIQUE"))return error(409,"REMEDIATION_EXISTS","A remediation record already exists for this finding.");throw e;}
   return response(201,{action:hydrate(db.prepare("SELECT * FROM control_remediation_actions WHERE id=?").get(id))});
  }
  const match=path.match(/^\/api\/finance\/remediations\/([0-9a-f-]{36})(?:\/(evidence|transitions))?$/i);
  if(!match)return error(404,"NOT_FOUND","Remediation route not found.");
  const [,id,subroute]=match;
  const row=actionFor(ownerId,id);
  if(!row)return error(404,"NOT_FOUND","Remediation record not found.");
  const projectAccess=row.project_id?access(ownerId,row.project_id,false):row.owner_id===ownerId?{access_role:"owner"}:null;
  if(!projectAccess)return error(404,"NOT_FOUND","Remediation record not found.");
  if(method==="GET"&&!subroute)return response(200,{action:hydrate(row)});
  if(method==="PATCH"&&!subroute){
   if(!access(ownerId,row.project_id,true)||row.owner_id!==ownerId&&projectAccess.access_role!=="owner")return error(403,"WRITE_FORBIDDEN","Project owner or editor access is required.");
   const expected=Number(body.expectedRevision);
   if(!Number.isSafeInteger(expected)||expected!==row.revision)return error(409,"REVISION_CONFLICT","Reload the remediation record before updating it.");
   const nextOwner=body.ownerId===undefined?row.assigned_owner_id:text(body.ownerId,64)||null;
   const nextReviewer=body.reviewerId===undefined?row.reviewer_id:text(body.reviewerId,64)||null;
   const dueAt=body.dueAt===undefined?row.due_at:date(body.dueAt);
   const actionPlan=body.actionPlan===undefined?row.action_plan:text(body.actionPlan,4000);
   if(nextOwner){const assignedAccess=member(ownerId,row.project_id,nextOwner);if(!assignedAccess||!["owner","editor"].includes(assignedAccess.access_role))return error(400,"INVALID_OWNER","Assigned owner must have owner or editor access to this project.");}
   if(nextReviewer){const reviewerAccess=member(ownerId,row.project_id,nextReviewer);if(!reviewerAccess||!["owner","reviewer"].includes(reviewerAccess.access_role)||nextReviewer===nextOwner)return error(400,"INVALID_REVIEWER","Reviewer must be a distinct project owner or reviewer.");}
   if(!nextOwner&&["in_progress","pending_review","verified"].includes(row.status))return error(409,"OWNER_REQUIRED","Reassign the remediation before removing its owner.");
   if(!dueAt)return error(400,"INVALID_DUE_DATE","Due date is invalid.");
   const result=db.prepare("UPDATE control_remediation_actions SET assigned_owner_id=?,reviewer_id=?,due_at=?,action_plan=?,status=CASE WHEN status='unassigned' AND ? IS NOT NULL THEN 'open' WHEN ? IS NULL AND status='open' THEN 'unassigned' ELSE status END,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND revision=?")
    .run(nextOwner,nextReviewer,dueAt,actionPlan,nextOwner,nextOwner,id,expected);
   if(!result.changes)return error(409,"REVISION_CONFLICT","Reload the remediation record before updating it.");
   appendHistory(id,ownerId,"details_updated",row.status,null,"Assignments, due date or action plan updated.");
   audit(db,ownerId,"control_remediation.updated","control_remediation",id,{revision:expected+1},row.project_id);
   return response(200,{action:hydrate(db.prepare("SELECT * FROM control_remediation_actions WHERE id=?").get(id))});
  }
  if(method==="POST"&&subroute==="evidence"){
   const label=text(body.label,180),capturedAt=date(body.capturedAt),kind=text(body.kind,24);
   const uri=text(body.uri,1000),sha256=text(body.sha256,64).toLowerCase();
   if(!label||!capturedAt||!evidenceKinds.has(kind)||sha256&&!/^[a-f0-9]{64}$/.test(sha256))return error(400,"INVALID_EVIDENCE","Evidence label, capture date, kind and optional SHA-256 are required in valid form.");
   if(!access(ownerId,row.project_id,true)||row.status==="verified")return error(403,"EVIDENCE_WRITE_FORBIDDEN","Only authorized project editors can add evidence to an unverified action.");
   const evidenceId=randomUUID();
   db.prepare("INSERT INTO control_remediation_evidence(id,action_id,submitted_by,label,evidence_uri,sha256,kind,captured_at) VALUES(?,?,?,?,?,?,?,?)").run(evidenceId,id,ownerId,label,uri||null,sha256||null,kind,capturedAt);
   db.prepare("UPDATE control_remediation_actions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(id);
   appendHistory(id,ownerId,"evidence_added",row.status,row.status,label,{evidenceId,sha256:sha256||null});
   audit(db,ownerId,"control_remediation.evidence_added","control_remediation",id,{evidenceId,kind,sha256:sha256||null},row.project_id);
   return response(201,{action:hydrate(db.prepare("SELECT * FROM control_remediation_actions WHERE id=?").get(id))});
  }
  if(method==="POST"&&subroute==="transitions"){
   const to=text(body.to,24),note=text(body.note,1000);
   if(!statuses.has(to)||!transitions[row.status].includes(to))return error(409,"INVALID_TRANSITION","Requested remediation status transition is not allowed.");
   const actorIsAssignedOwner=row.assigned_owner_id===ownerId;
   if(to==="in_progress"&&(!actorIsAssignedOwner&&!["owner","editor"].includes(projectAccess.access_role)))return error(403,"OWNER_REQUIRED","Assigned owner or project editor is required.");
   if(to==="pending_review"&&(!actorIsAssignedOwner||db.prepare("SELECT COUNT(*) AS count FROM control_remediation_evidence WHERE action_id=?").get(id).count<1))return error(409,"EVIDENCE_REQUIRED","The assigned owner must add evidence before requesting review.");
   if(to==="verified"){
    if(!row.reviewer_id||row.reviewer_id!==ownerId||actorIsAssignedOwner)return error(403,"INDEPENDENT_REVIEW_REQUIRED","Only the assigned independent reviewer can verify this remediation.");
    if(db.prepare("SELECT COUNT(*) AS count FROM control_remediation_evidence WHERE action_id=?").get(id).count<1)return error(409,"EVIDENCE_REQUIRED","Evidence is required before verification.");
   }
   if(to==="reopened"&&!["owner","reviewer"].includes(projectAccess.access_role))return error(403,"REVIEWER_REQUIRED","Project owner or reviewer is required to reopen a verified action.");
   const verified=to==="verified",reopened=to==="reopened";
   db.prepare("UPDATE control_remediation_actions SET status=?,verified_at=?,verified_by=?,reopened_count=reopened_count+?,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
    .run(to,verified?new Date().toISOString():reopened?null:row.verified_at,verified?ownerId:reopened?null:row.verified_by,reopened?1:0,id);
   appendHistory(id,ownerId,"status_transition",row.status,to,note);
   audit(db,ownerId,"control_remediation.status_changed","control_remediation",id,{from:row.status,to},row.project_id);
   return response(200,{action:hydrate(db.prepare("SELECT * FROM control_remediation_actions WHERE id=?").get(id))});
  }
  return error(405,"METHOD_NOT_ALLOWED","Method is not supported for this remediation route.");
 }
 return {handle};
}
