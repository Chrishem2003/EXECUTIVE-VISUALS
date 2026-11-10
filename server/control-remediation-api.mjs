import { createHash, randomUUID } from "node:crypto";
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
 function slaState(row,now=Date.now()){
  if(row.status==="verified")return "completed";
  const due=Date.parse(String(row.due_at||""));
  if(!Number.isFinite(due))return "unknown";
  if(due<now)return "overdue";
  if(due<=now+72*60*60*1000)return "due_soon";
  return "on_track";
 }
 function hydrate(row){
  const evidence=db.prepare("SELECT e.id,e.label,e.evidence_uri AS uri,e.sha256,e.kind,e.captured_at AS capturedAt,e.submitted_by AS submittedBy,e.created_at AS createdAt,CASE WHEN a.id IS NOT NULL THEN a.id END AS assetId,a.original_name AS fileName,a.media_type AS mediaType,a.byte_size AS byteSize FROM control_remediation_evidence e LEFT JOIN assets a ON a.id=substr(e.evidence_uri,9) AND a.deleted_at IS NULL WHERE e.action_id=? ORDER BY e.created_at,e.id").all(row.id).map(item=>({...item,scanStatus:item.assetId?"not_scanned":"unavailable"}));
  const evidenceDownloads=db.prepare("SELECT owner_id AS actorId,details_json,created_at AS at FROM audit_events WHERE subject_type='control_remediation' AND subject_id=? AND event_type='control_remediation.evidence_downloaded' ORDER BY id DESC LIMIT 25").all(row.id).map(item=>({...item,details:parseJson(item.details_json)}));
  return {...safeAction(row),slaState:slaState(row),evidence,evidenceDownloads,
   history:db.prepare("SELECT id,actor_id AS actorId,event_type AS event,from_status AS fromStatus,to_status AS toStatus,note,details_json,created_at AS at FROM control_remediation_history WHERE action_id=? ORDER BY id").all(row.id).map(x=>({...x,details:parseJson(x.details_json)}))};
 }
 function recordEvidenceDownload({ownerId,assetId}={}){
  if(!UUID.test(String(ownerId||""))||!UUID.test(String(assetId||"")))return 0;
  const links=db.prepare("SELECT e.id AS evidence_id,e.label,e.sha256,e.kind,a.id AS action_id,a.project_id,a.owner_id FROM control_remediation_evidence e JOIN control_remediation_actions a ON a.id=e.action_id WHERE e.evidence_uri=?").all("asset://"+assetId);
  let recorded=0;
  for(const link of links){
   const allowed=link.project_id?!!access(ownerId,link.project_id,false):link.owner_id===ownerId;
   if(!allowed)continue;
   audit(db,ownerId,"control_remediation.evidence_downloaded","control_remediation",link.action_id,{evidenceId:link.evidence_id,assetId,kind:link.kind,label:link.label,sha256:link.sha256},link.project_id);
   recorded++;
  }
  return recorded;
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
  const exportMatch=path.match(/^\/api\/finance\/remediations\/([0-9a-f-]{36})\/audit-export$/i);
  if(exportMatch&&method==="GET"){
   const [,id]=exportMatch,row=actionFor(ownerId,id);
   if(!row)return error(404,"NOT_FOUND","Remediation record not found.");
   const projectAccess=row.project_id?access(ownerId,row.project_id,false):row.owner_id===ownerId?{access_role:"owner"}:null;
   if(!projectAccess)return error(404,"NOT_FOUND","Remediation record not found.");
   const history=db.prepare("SELECT id,actor_id AS actorId,event_type AS event,from_status AS fromStatus,to_status AS toStatus,note,details_json,created_at AS at FROM control_remediation_history WHERE action_id=? ORDER BY id").all(id).map(x=>({...x,details:parseJson(x.details_json)}));
   const auditEvents=db.prepare("SELECT id,owner_id AS actorId,event_type AS event,subject_type AS subjectType,subject_id AS subjectId,details_json,created_at AS at FROM audit_events WHERE subject_type='control_remediation' AND subject_id=? ORDER BY id").all(id).map(x=>({...x,details:parseJson(x.details_json)}));
   const evidence=db.prepare("SELECT id,label,sha256,kind,captured_at AS capturedAt,submitted_by AS submittedBy,created_at AS createdAt FROM control_remediation_evidence WHERE action_id=? ORDER BY created_at,id").all(id);
   const payload={schemaVersion:1,action:safeAction(row),history,auditEvents,evidence};
   const canonical=JSON.stringify(payload),sha256=createHash("sha256").update(canonical,"utf8").digest("hex");
   return response(200,{payload,integrity:{algorithm:"SHA-256",canonicalization:"UTF-8 JSON.stringify(payload), property insertion order preserved",sha256,historyCount:history.length,auditEventCount:auditEvents.length,evidenceCount:evidence.length,generatedAt:new Date().toISOString(),scope:"integrity-after-export-only"}});
  }
  if(path==="/api/finance/remediations/portfolio-report"&&method==="GET"){
   const requested=Number.parseInt(String(query.limit||"250"),10),limit=Number.isFinite(requested)?Math.min(500,Math.max(1,requested)):250;
   const scope="((a.project_id IS NULL AND a.owner_id=?) OR (a.project_id IS NOT NULL AND a.project_id IN (SELECT p.id FROM projects p WHERE p.archived_at IS NULL AND (p.owner_id=? OR p.id IN (SELECT pm.project_id FROM project_members pm WHERE pm.member_id=?)))))";
   const params=[ownerId,ownerId,ownerId];
   const total=Number(db.prepare("SELECT COUNT(*) AS total FROM control_remediation_actions a WHERE "+scope).get(...params)?.total||0);
   const rows=db.prepare("SELECT a.*,COALESCE(p.name,'Personal workspace') AS project_name FROM control_remediation_actions a LEFT JOIN projects p ON p.id=a.project_id WHERE "+scope+" ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,datetime(a.due_at),a.created_at,a.id LIMIT ?").all(...params,limit);
   const ids=rows.map(row=>row.id),marks=ids.map(()=>"?").join(",");
   const history=ids.length?db.prepare("SELECT h.action_id AS actionId,h.id,h.actor_id AS actorId,h.event_type AS event,h.from_status AS fromStatus,h.to_status AS toStatus,h.note,h.details_json,h.created_at AS at FROM control_remediation_history h WHERE h.action_id IN ("+marks+") ORDER BY h.action_id,h.id").all(...ids).map(x=>({...x,details:parseJson(x.details_json)})):[];
   const evidence=ids.length?db.prepare("SELECT e.action_id AS actionId,e.id,e.label,e.sha256,e.kind,e.captured_at AS capturedAt,e.submitted_by AS submittedBy,e.created_at AS createdAt,CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS assetLinked FROM control_remediation_evidence e LEFT JOIN assets a ON a.id=substr(e.evidence_uri,9) AND a.deleted_at IS NULL WHERE e.action_id IN ("+marks+") ORDER BY e.action_id,e.created_at,e.id").all(...ids):[];
   const auditEvents=ids.length?db.prepare("SELECT id,owner_id AS actorId,event_type AS event,subject_id AS actionId,details_json,created_at AS at FROM audit_events WHERE subject_type='control_remediation' AND subject_id IN ("+marks+") ORDER BY subject_id,id").all(...ids).map(x=>({...x,details:parseJson(x.details_json)})):[];
   const group=(items,key)=>{const map=new Map();for(const item of items){const id=item[key];if(!map.has(id))map.set(id,[]);map.get(id).push(item);}return map;};
   const historyByAction=group(history,"actionId"),evidenceByAction=group(evidence,"actionId"),auditByAction=group(auditEvents,"actionId");
   const actions=rows.map(row=>({...safeAction(row),projectName:row.project_name,history:(historyByAction.get(row.id)||[]).map(({actionId,...item})=>item),evidence:(evidenceByAction.get(row.id)||[]).map(({actionId,...item})=>item),auditEvents:(auditByAction.get(row.id)||[]).map(({actionId,...item})=>item)}));
   const payload={schemaVersion:1,reportType:"executive-financial-assurance",generatedAt:new Date().toISOString(),scope:{description:"Authenticated user's personal remediation records and currently accessible, non-archived projects.",archivedProjectsIncluded:false,foreignProjectRecordsIncluded:false,privateEvidenceBytesIncluded:false,privateStoragePathsIncluded:false},completeness:{totalRecords:total,recordsIncluded:actions.length,truncated:actions.length<total,limit},summary:{open:actions.filter(x=>x.status!=="verified").length,verified:actions.filter(x=>x.status==="verified").length,criticalOpen:actions.filter(x=>x.status!=="verified"&&x.severity==="critical").length,highOpen:actions.filter(x=>x.status!=="verified"&&x.severity==="high").length,overdueOpen:actions.filter(x=>x.status!=="verified"&&Date.parse(String(x.dueAt))<Date.now()).length,awaitingReview:actions.filter(x=>x.status==="pending_review").length,evidenceItems:evidence.length},actions};
   const canonical=JSON.stringify(payload),sha256=createHash("sha256").update(canonical,"utf8").digest("hex");
   return response(200,{payload,integrity:{algorithm:"SHA-256",canonicalization:"UTF-8 JSON.stringify(payload), property insertion order preserved",sha256,actionCount:actions.length,historyCount:history.length,auditEventCount:auditEvents.length,evidenceCount:evidence.length,generatedAt:new Date().toISOString(),signatureStatus:"unsigned-digest-only",meaning:"Detects changes after export; does not authenticate the issuer or prove the source database was truthful."}});
  }
  if(path==="/api/finance/remediations/assurance"&&method==="GET"){
   const scope="((a.project_id IS NULL AND a.owner_id=?) OR (a.project_id IS NOT NULL AND a.project_id IN (SELECT p.id FROM projects p WHERE p.archived_at IS NULL AND (p.owner_id=? OR p.id IN (SELECT pm.project_id FROM project_members pm WHERE pm.member_id=?)))))";
   const params=[ownerId,ownerId,ownerId];
   const totals=db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN a.status<>'verified' THEN 1 ELSE 0 END) AS open,SUM(CASE WHEN a.severity='critical' AND a.status<>'verified' THEN 1 ELSE 0 END) AS criticalOpen,SUM(CASE WHEN a.severity='high' AND a.status<>'verified' THEN 1 ELSE 0 END) AS highOpen,SUM(CASE WHEN a.severity='medium' AND a.status<>'verified' THEN 1 ELSE 0 END) AS mediumOpen,SUM(CASE WHEN a.severity='low' AND a.status<>'verified' THEN 1 ELSE 0 END) AS lowOpen,SUM(CASE WHEN a.status='verified' THEN 1 ELSE 0 END) AS verified,SUM(CASE WHEN a.status='pending_review' THEN 1 ELSE 0 END) AS pendingReview,SUM(CASE WHEN a.status<>'verified' AND datetime(a.due_at)<datetime('now') THEN 1 ELSE 0 END) AS overdue,SUM(CASE WHEN a.status<>'verified' AND datetime(a.due_at)>=datetime('now') AND datetime(a.due_at)<=datetime('now','+72 hours') THEN 1 ELSE 0 END) AS dueSoon,SUM(CASE WHEN a.status<>'verified' AND a.assigned_owner_id IS NULL THEN 1 ELSE 0 END) AS unassignedOwner,SUM(CASE WHEN a.status<>'verified' AND a.reviewer_id IS NULL THEN 1 ELSE 0 END) AS missingReviewer,SUM(CASE WHEN NOT EXISTS(SELECT 1 FROM control_remediation_evidence e WHERE e.action_id=a.id) THEN 1 ELSE 0 END) AS withoutEvidence,SUM(CASE WHEN EXISTS(SELECT 1 FROM control_remediation_evidence e WHERE e.action_id=a.id) THEN 1 ELSE 0 END) AS withEvidence FROM control_remediation_actions a WHERE "+scope).get(...params);
   const byProject=db.prepare("SELECT COALESCE(p.id,'personal') AS projectId,COALESCE(p.name,'Personal workspace') AS projectName,COUNT(*) AS total,SUM(CASE WHEN a.status<>'verified' THEN 1 ELSE 0 END) AS open,SUM(CASE WHEN a.severity IN ('critical','high') AND a.status<>'verified' THEN 1 ELSE 0 END) AS highPriority,SUM(CASE WHEN a.status<>'verified' AND datetime(a.due_at)<datetime('now') THEN 1 ELSE 0 END) AS overdue,SUM(CASE WHEN a.status='pending_review' THEN 1 ELSE 0 END) AS pendingReview,SUM(CASE WHEN NOT EXISTS(SELECT 1 FROM control_remediation_evidence e WHERE e.action_id=a.id) THEN 1 ELSE 0 END) AS evidenceGaps FROM control_remediation_actions a LEFT JOIN projects p ON p.id=a.project_id WHERE "+scope+" GROUP BY a.project_id,p.name ORDER BY highPriority DESC,overdue DESC,open DESC,projectName COLLATE NOCASE LIMIT 25").all(...params);
   const priorityRows=db.prepare("SELECT a.id,a.project_id AS projectId,COALESCE(p.name,'Personal workspace') AS projectName,a.finding_id AS findingId,a.control_id AS controlId,a.title,a.severity,a.status,a.due_at AS dueAt,a.assigned_owner_id AS ownerId,a.reviewer_id AS reviewerId,(SELECT COUNT(*) FROM control_remediation_evidence e WHERE e.action_id=a.id) AS evidenceCount FROM control_remediation_actions a LEFT JOIN projects p ON p.id=a.project_id WHERE "+scope+" AND a.status<>'verified' ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,CASE WHEN datetime(a.due_at)<datetime('now') THEN 0 ELSE 1 END,datetime(a.due_at) ASC,a.created_at ASC LIMIT 12").all(...params);
   const n=key=>Number(totals?.[key]||0),total=n("total"),open=n("open"),withEvidence=n("withEvidence");
   return response(200,{generatedAt:new Date().toISOString(),scope:{projects:"currently accessible, non-archived projects plus authenticated user's personal records",includesArchived:false,limit:25},totals:{total,open,criticalOpen:n("criticalOpen"),highOpen:n("highOpen"),mediumOpen:n("mediumOpen"),lowOpen:n("lowOpen"),verified:n("verified"),pendingReview:n("pendingReview"),overdue:n("overdue"),dueSoon:n("dueSoon"),unassignedOwner:n("unassignedOwner"),missingReviewer:n("missingReviewer"),withoutEvidence:n("withoutEvidence"),withEvidence},coverage:{evidenceAttached:withEvidence,evidenceMissing:n("withoutEvidence"),evidenceCoveragePct:total?Math.round(withEvidence/total*100):null,ownerAssigned:total-n("unassignedOwner"),reviewerAssigned:total-n("missingReviewer")},byProject,priorityItems:priorityRows,policy:{dueSoonHours:72,overdueRule:"unverified action with dueAt earlier than server time",riskRanking:"severity, then overdue status, then earliest due date",score:"No composite risk score or fraud inference is calculated"}});
  }
  if(path==="/api/finance/remediations/reviewer-performance"&&method==="GET"){
   const scope="a.project_id IS NOT NULL AND a.reviewer_id IS NOT NULL AND a.project_id IN (SELECT p.id FROM projects p WHERE p.archived_at IS NULL AND (p.owner_id=? OR p.id IN (SELECT pm.project_id FROM project_members pm WHERE pm.member_id=?)))";
   const rows=db.prepare("SELECT a.id,a.project_id AS projectId,COALESCE(p.name,'Project') AS projectName,a.reviewer_id AS reviewerId,a.status,a.due_at AS dueAt,h.id AS historyId,h.actor_id AS actorId,h.event_type AS event,h.from_status AS fromStatus,h.to_status AS toStatus,h.created_at AS at FROM control_remediation_actions a JOIN projects p ON p.id=a.project_id LEFT JOIN control_remediation_history h ON h.action_id=a.id WHERE "+scope+" ORDER BY a.reviewer_id,a.id,h.id").all(ownerId,ownerId);
   const byAction=new Map();
   for(const row of rows){if(!byAction.has(row.id))byAction.set(row.id,{id:row.id,projectId:row.projectId,projectName:row.projectName,reviewerId:row.reviewerId,status:row.status,dueAt:row.dueAt,history:[]});if(row.historyId)byAction.get(row.id).history.push({actorId:row.actorId,event:row.event,fromStatus:row.fromStatus,toStatus:row.toStatus,at:row.at});}
   const actions=[...byAction.values()],now=Date.now(),reviewers=new Map(),projectGroups=new Map(),turnarounds=[];
   const median=values=>{if(!values.length)return null;const sorted=values.slice().sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;};
   for(const action of actions){
    if(!reviewers.has(action.reviewerId))reviewers.set(action.reviewerId,{reviewerId:action.reviewerId,assigned:0,awaitingReview:0,actionDeadlineOverdueAwaiting:0,verifiedByReviewer:0,turnaroundHours:[],pendingAgeHours:[]});
    const reviewer=reviewers.get(action.reviewerId);reviewer.assigned++;
    if(action.status==="pending_review"){reviewer.awaitingReview++;const due=Date.parse(String(action.dueAt||""));if(Number.isFinite(due)&&due<now)reviewer.actionDeadlineOverdueAwaiting++;const submitted=action.history.filter(h=>h.toStatus==="pending_review").at(-1);const age=submitted?Math.max(0,(now-Date.parse(submitted.at))/3600000):null;if(age!==null&&Number.isFinite(age))reviewer.pendingAgeHours.push(age);}
    const verifiedEvents=action.history.filter(h=>h.toStatus==="verified"&&h.actorId===action.reviewerId);
    for(const verified of verifiedEvents){const verifiedAt=Date.parse(verified.at);const submitted=action.history.filter(h=>h.toStatus==="pending_review"&&Date.parse(h.at)<=verifiedAt).at(-1);const submittedAt=submitted?Date.parse(submitted.at):NaN;if(Number.isFinite(submittedAt)&&Number.isFinite(verifiedAt)&&verifiedAt>=submittedAt){reviewer.turnaroundHours.push((verifiedAt-submittedAt)/3600000);reviewer.verifiedByReviewer++;}}
    if(!projectGroups.has(action.projectId))projectGroups.set(action.projectId,{projectId:action.projectId,projectName:action.projectName,assigned:0,awaitingReview:0,actionDeadlineOverdueAwaiting:0,verifiedByReviewer:0});
    const project=projectGroups.get(action.projectId);project.assigned++;if(action.status==="pending_review"){project.awaitingReview++;if(Date.parse(String(action.dueAt||""))<now)project.actionDeadlineOverdueAwaiting++;}project.verifiedByReviewer+=verifiedEvents.length;
   }
   const reviewerRows=[...reviewers.values()].map(r=>({reviewerId:r.reviewerId,assigned:r.assigned,awaitingReview:r.awaitingReview,actionDeadlineOverdueAwaiting:r.actionDeadlineOverdueAwaiting,verifiedByReviewer:r.verifiedByReviewer,medianTurnaroundHours:median(r.turnaroundHours),averageTurnaroundHours:r.turnaroundHours.length?Math.round(r.turnaroundHours.reduce((a,b)=>a+b,0)/r.turnaroundHours.length*100)/100:null,measuredReviews:r.turnaroundHours.length,medianCurrentPendingAgeHours:median(r.pendingAgeHours)})).sort((a,b)=>b.awaitingReview-a.awaitingReview||b.actionDeadlineOverdueAwaiting-a.actionDeadlineOverdueAwaiting||a.reviewerId.localeCompare(b.reviewerId));
   const allTurnarounds=reviewerRows.flatMap(r=>reviewers.get(r.reviewerId).turnaroundHours);
   return response(200,{generatedAt:new Date().toISOString(),scope:{description:"Reviewer assignments in currently accessible, non-archived projects.",archivedProjectsIncluded:false,personalRecordsIncluded:false,reviewerIdentity:"Opaque account ID only; no names or email addresses."},totals:{assigned:actions.length,awaitingReview:actions.filter(a=>a.status==="pending_review").length,actionDeadlineOverdueAwaiting:actions.filter(a=>a.status==="pending_review"&&Date.parse(String(a.dueAt||""))<now).length,verifiedByAssignedReviewer:reviewerRows.reduce((n,r)=>n+r.verifiedByReviewer,0),measuredReviews:allTurnarounds.length,portfolioMedianTurnaroundHours:median(allTurnarounds)},reviewers:reviewerRows,byProject:[...projectGroups.values()].sort((a,b)=>b.awaitingReview-a.awaitingReview||a.projectName.localeCompare(b.projectName)),policy:{turnaround:"Elapsed calendar hours from the latest submission-to-review event preceding a verification by the assigned reviewer.",pendingAge:"Elapsed calendar hours since the latest submission to the current review queue.",deadline:"dueAt is the remediation action deadline, not a reviewer-specific SLA deadline.",slaConfigured:false,excluded:"Unverified reviewer completions, missing timestamps, and personal records are excluded from measured reviewer turnaround."}});
  }
  if(path==="/api/finance/remediations/inbox"&&method==="GET"){
   const projectId=text(query.projectId,64)||null,status=text(query.status,24)||null,limit=Math.min(100,Math.max(1,Number.parseInt(String(query.limit||"50"),10)||50));
   if(projectId&&!UUID.test(projectId))return error(400,"INVALID_PROJECT","Project ID is invalid.");
   if(status&&!statuses.has(status))return error(400,"INVALID_STATUS","Reviewer inbox status filter is invalid.");
   const where="a.reviewer_id=? AND a.project_id IS NOT NULL AND a.project_id IN (SELECT p.id FROM projects p WHERE p.archived_at IS NULL AND (p.owner_id=? OR p.id IN (SELECT pm.project_id FROM project_members pm WHERE pm.member_id=?))) AND (? IS NULL OR a.project_id=?) AND (? IS NULL OR a.status=?)";
   const params=[ownerId,ownerId,ownerId,projectId,projectId,status,status];
   const countsRow=db.prepare("SELECT COUNT(*) AS total,SUM(CASE WHEN a.status='pending_review' THEN 1 ELSE 0 END) AS awaitingReview,SUM(CASE WHEN a.status<>'verified' AND datetime(a.due_at)<datetime('now') THEN 1 ELSE 0 END) AS overdue,SUM(CASE WHEN a.status<>'verified' AND datetime(a.due_at)>=datetime('now') AND datetime(a.due_at)<=datetime('now','+72 hours') THEN 1 ELSE 0 END) AS dueSoon,SUM(CASE WHEN a.status<>'verified' AND datetime(a.due_at)>datetime('now','+72 hours') THEN 1 ELSE 0 END) AS onTrack,SUM(CASE WHEN a.status='verified' THEN 1 ELSE 0 END) AS completed FROM control_remediation_actions a WHERE "+where).get(...params);
   const rows=db.prepare("SELECT a.* FROM control_remediation_actions a WHERE "+where+" ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,a.due_at,a.created_at LIMIT ?").all(...params,limit);
   const actions=rows.map(hydrate),counts=Object.fromEntries(["total","awaitingReview","overdue","dueSoon","onTrack","completed"].map(key=>[key,Number(countsRow?.[key]||0)]));
   return response(200,{actions,counts,policy:{dueSoonHours:72,overdueRule:"dueAt is earlier than server time",escalation:"visibility only; no automatic reassignment or notifications"},limit});
  }
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
   const assignedOwnerId=text(body.ownerId,64)||(!projectId?ownerId:null),reviewerId=text(body.reviewerId,64)||null;
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
   const label=text(body.label,180),capturedAt=date(body.capturedAt),kind=text(body.kind,24),assetId=text(body.assetId,64);
   if(!label||!capturedAt||!evidenceKinds.has(kind)||!UUID.test(assetId))return error(400,"INVALID_EVIDENCE","Evidence label, capture date, kind and a managed evidence asset are required.");
   if(!access(ownerId,row.project_id,true)||row.status==="verified")return error(403,"EVIDENCE_WRITE_FORBIDDEN","Only authorized project editors can add evidence to an unverified action.");
   const asset=db.prepare("SELECT id,owner_id,project_id,original_name,media_type,byte_size,sha256 FROM assets WHERE id=? AND deleted_at IS NULL").get(assetId);
   if(!asset||asset.owner_id!==ownerId||asset.project_id!==(row.project_id||null))return error(404,"EVIDENCE_ASSET_NOT_FOUND","Upload the evidence to this account or shared project before attaching it.");
   const allowedExtensions={"application/pdf":[".pdf"],"image/png":[".png"],"image/jpeg":[".jpg",".jpeg"]};
   const allowed=allowedExtensions[asset.media_type],filename=String(asset.original_name||"").toLowerCase();
   if(!allowed||!allowed.some(ext=>filename.endsWith(ext))||!Number.isSafeInteger(Number(asset.byte_size))||Number(asset.byte_size)<1||Number(asset.byte_size)>10*1024*1024||!/^[a-f0-9]{64}$/i.test(String(asset.sha256||"")))return error(415,"UNSUPPORTED_EVIDENCE_FILE","Evidence must be a PDF, PNG or JPEG file no larger than 10 MB with a verified stored SHA-256.");
   const evidenceId=randomUUID();
   try{
    db.exec("BEGIN IMMEDIATE");
    const changed=db.prepare("UPDATE control_remediation_actions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND revision=? AND status<>'verified'").run(id,row.revision);
    if(!changed.changes){db.exec("ROLLBACK");return error(409,"REVISION_CONFLICT","This remediation changed while evidence was being attached. Reload and retry.");}
    db.prepare("INSERT INTO control_remediation_evidence(id,action_id,submitted_by,label,evidence_uri,sha256,kind,captured_at) VALUES(?,?,?,?,?,?,?,?)").run(evidenceId,id,ownerId,label,"asset://"+asset.id,asset.sha256,kind,capturedAt);
    appendHistory(id,ownerId,"evidence_file_attached",row.status,row.status,label,{evidenceId,assetId:asset.id,sha256:asset.sha256,mediaType:asset.media_type,byteSize:Number(asset.byte_size),scanStatus:"not_scanned"});
    audit(db,ownerId,"control_remediation.evidence_file_attached","control_remediation",id,{evidenceId,assetId:asset.id,sha256:asset.sha256,mediaType:asset.media_type,byteSize:Number(asset.byte_size),scanStatus:"not_scanned"},row.project_id);
    db.exec("COMMIT");
   }catch(e){try{db.exec("ROLLBACK");}catch{}throw e;}
   return response(201,{action:hydrate(db.prepare("SELECT * FROM control_remediation_actions WHERE id=?").get(id))});
  }
  if(method==="POST"&&subroute==="transitions"){
   const to=text(body.to,24),note=text(body.note,1000);
   if(!statuses.has(to)||!transitions[row.status].includes(to))return error(409,"INVALID_TRANSITION","Requested remediation status transition is not allowed.");
   const actorIsAssignedOwner=row.assigned_owner_id===ownerId;
   if(to==="in_progress"&&row.status==="pending_review"){
    if(!row.project_id||row.reviewer_id!==ownerId&&projectAccess.access_role!=="owner")return error(403,"REVIEWER_REQUIRED","Only the assigned reviewer or project owner can return a submitted action for rework.");
    if(!note)return error(400,"REVIEW_NOTE_REQUIRED","Provide a clear review note explaining the changes required.");
   }else if(to==="in_progress"&&(!actorIsAssignedOwner&&(!row.project_id||!["owner","editor"].includes(projectAccess.access_role))))return error(403,"OWNER_REQUIRED","Assigned owner or authorized project editor is required.");
   if(to==="pending_review"&&!row.reviewer_id)return error(409,"REVIEWER_NOT_ASSIGNED","Assign a distinct project reviewer before submitting this action for review.");
   if(to==="pending_review"&&(!actorIsAssignedOwner||db.prepare("SELECT COUNT(*) AS count FROM control_remediation_evidence WHERE action_id=?").get(id).count<1))return error(409,"EVIDENCE_REQUIRED","The assigned owner must add evidence before requesting review.");
   if(to==="verified"){
    if(!row.reviewer_id||row.reviewer_id!==ownerId||actorIsAssignedOwner)return error(403,"INDEPENDENT_REVIEW_REQUIRED","Only the assigned independent reviewer can verify this remediation.");
    if(db.prepare("SELECT COUNT(*) AS count FROM control_remediation_evidence WHERE action_id=?").get(id).count<1)return error(409,"EVIDENCE_REQUIRED","Evidence is required before verification.");
   }
   if(to==="reopened"&&!["owner","reviewer"].includes(projectAccess.access_role))return error(403,"REVIEWER_REQUIRED","Project owner or reviewer is required to reopen a verified action.");
   const verified=to==="verified",reopened=to==="reopened";
   try{
    db.exec("BEGIN IMMEDIATE");
    const changed=db.prepare("UPDATE control_remediation_actions SET status=?,verified_at=?,verified_by=?,reopened_count=reopened_count+?,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND revision=? AND status=?")
     .run(to,verified?new Date().toISOString():reopened?null:row.verified_at,verified?ownerId:reopened?null:row.verified_by,reopened?1:0,id,row.revision,row.status);
    if(!changed.changes){db.exec("ROLLBACK");return error(409,"REVISION_CONFLICT","This action changed during review. Reload it before trying again.");}
    appendHistory(id,ownerId,row.status==="pending_review"&&to==="in_progress"?"review_changes_requested":"status_transition",row.status,to,note);
    audit(db,ownerId,"control_remediation.status_changed","control_remediation",id,{from:row.status,to,reviewNote:row.status==="pending_review"&&to==="in_progress"?note:undefined},row.project_id);
    db.exec("COMMIT");
   }catch(e){try{db.exec("ROLLBACK");}catch{}throw e;}
   return response(200,{action:hydrate(db.prepare("SELECT * FROM control_remediation_actions WHERE id=?").get(id))});
  }
  return error(405,"METHOD_NOT_ALLOWED","Method is not supported for this remediation route.");
 }
 return {handle,recordEvidenceDownload};
}
