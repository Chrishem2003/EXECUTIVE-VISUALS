import { randomUUID } from "node:crypto";
import { canWriteProject, getAccessibleAsset, getProjectAccess, json, parseJson } from "./db.mjs";

const OPERATIONS=new Set(["vehicle_replace","wardrobe_replace","wardrobe_transform","object_replace","background_replace","person_replace","style_transfer","visual_restyle","object_remove","relight"]);
const PRESERVATION=new Set(["camera_movement","camera_motion","timing","composition","source_audio","subject_identity","pose_movement","pose","lighting","background"]);
const fail=(message,code,status=400)=>Object.assign(new Error(message),{code,status});
const cleanText=(value,max)=>typeof value==="string"?value.trim().slice(0,max):"";
const record=row=>row?({
 id:row.id,projectId:row.project_id,sourceAssetId:row.source_asset_id,operation:row.operation,
 prompt:row.prompt,durationSeconds:row.duration_seconds,referenceAssetIds:parseJson(row.reference_asset_ids_json,[]),
 preservation:parseJson(row.preservation_json,[]),status:row.status,
 rightsConfirmed:!!row.rights_confirmed,subjectConsentConfirmed:!!row.subject_consent_confirmed,
 approval:row.approval_id?{id:row.approval_id,estimatedCostMicros:row.estimated_cost_micros,approvedBudgetMicros:row.approved_budget_micros,currency:row.currency,adapterId:row.adapter_id,capability:row.capability,approvedAt:row.approved_at}:null,
 createdAt:row.created_at,updatedAt:row.updated_at
}):null;

export function ensureTransformationPlanSchema(db){
 db.exec(`
 CREATE TABLE IF NOT EXISTS transformation_plans(
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_asset_id TEXT NOT NULL REFERENCES assets(id),
  operation TEXT NOT NULL,
  prompt TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 1 AND 30),
  reference_asset_ids_json TEXT NOT NULL DEFAULT '[]',
  preservation_json TEXT NOT NULL DEFAULT '[]',
  rights_confirmed INTEGER NOT NULL CHECK(rights_confirmed IN (0,1)),
  subject_consent_confirmed INTEGER NOT NULL CHECK(subject_consent_confirmed IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('draft','approved','queued','running','succeeded','failed','cancelled')),
  idempotency_key TEXT NOT NULL,
  approval_id TEXT,
  estimated_cost_micros INTEGER,
  approved_budget_micros INTEGER,
  currency TEXT,
  adapter_id TEXT,
  capability TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(owner_id,idempotency_key)
 );
 CREATE INDEX IF NOT EXISTS transformation_plans_project_idx ON transformation_plans(project_id,created_at DESC);
 `);
}

export function createTransformationPlan(db,{ownerId,body,idempotencyKey}={}){
 if(!ownerId)throw fail("Authentication is required.","AUTH_REQUIRED",401);
 if(!body||typeof body!=="object"||Array.isArray(body))throw fail("Transformation request must be a JSON object.","TRANSFORMATION_BODY_INVALID");
 const allowedFields=new Set(["projectId","sourceAssetId","operation","prompt","durationSeconds","referenceAssetIds","preservation","rightsConfirmed","subjectConsentConfirmed","idempotencyKey"]);
 if(Object.keys(body).some(key=>!allowedFields.has(key)))throw fail("Transformation request contains an unsupported field.","TRANSFORMATION_FIELD_UNSUPPORTED");
 if(typeof body.projectId!=="string"||typeof body.sourceAssetId!=="string")throw fail("Project and source asset IDs must be strings.","TRANSFORMATION_INPUT_INVALID");
 const projectId=body.projectId.trim(),sourceAssetId=body.sourceAssetId.trim();
 if(!projectId||!sourceAssetId||projectId.length>80||sourceAssetId.length>80||!canWriteProject(db,ownerId,projectId))throw fail("Project not found or editor access required.","PROJECT_NOT_FOUND",404);
 const source=getAccessibleAsset(db,ownerId,sourceAssetId,true);
 if(!source||source.media_type?.startsWith("video/")!==true||source.project_id!==projectId)throw fail("Source video must be an editable asset in this project.","SOURCE_VIDEO_INVALID",422);
 if(typeof body.operation!=="string")throw fail("Transformation operation must be a string.","TRANSFORMATION_OPERATION_INVALID");
 const operation=body.operation.trim();
 if(!OPERATIONS.has(operation))throw fail("Choose a supported transformation operation.","TRANSFORMATION_OPERATION_INVALID");
 const prompt=typeof body.prompt==="string"?body.prompt.trim():"";
 if(prompt.length<8||prompt.length>8000)throw fail("Describe the requested visual change in 8–8,000 characters.","TRANSFORMATION_PROMPT_INVALID");
 const duration=body.durationSeconds;
 if(!Number.isInteger(duration)||duration<1||duration>30)throw fail("Transformation duration must be between 1 and 30 seconds.","TRANSFORMATION_DURATION_INVALID");
 if(body.rightsConfirmed!==true)throw fail("Confirm that you have the rights to use the source and reference media.","MEDIA_RIGHTS_REQUIRED",403);
 if(operation==="person_replace"&&body.subjectConsentConfirmed!==true)throw fail("Explicit subject consent is required for person replacement.","SUBJECT_CONSENT_REQUIRED",403);
 if(body.referenceAssetIds!==undefined&&!Array.isArray(body.referenceAssetIds))throw fail("Reference asset IDs must be an array.","REFERENCE_ASSET_INVALID");
 if(body.referenceAssetIds!==undefined&&body.referenceAssetIds.some(value=>typeof value!=="string"||!value.trim()||value.length>80))throw fail("Reference asset IDs must be non-empty strings of at most 80 characters.","REFERENCE_ASSET_INVALID");
 const refs=body.referenceAssetIds===undefined?[]:body.referenceAssetIds.map(value=>value.trim());
 if(refs.length>4)throw fail("Use no more than four reference images.","REFERENCE_LIMIT_EXCEEDED");
 if(new Set(refs).size!==refs.length)throw fail("Reference asset IDs cannot contain duplicates.","REFERENCE_ASSET_INVALID");
 for(const id of refs){
  const asset=getAccessibleAsset(db,ownerId,id,true);
  if(!asset||!asset.media_type?.startsWith("image/")||asset.project_id!==projectId)throw fail("Every reference must be an editable image asset in the same project.","REFERENCE_ASSET_INVALID",422);
 }
 if(body.preservation!==undefined&&(!Array.isArray(body.preservation)||body.preservation.length>10||body.preservation.some(value=>typeof value!=="string"||!PRESERVATION.has(value))))throw fail("One or more preservation constraints are unsupported.","TRANSFORMATION_PRESERVATION_INVALID");
 const preservation=body.preservation===undefined?[]:[...body.preservation];
 if(new Set(preservation).size!==preservation.length)throw fail("Preservation constraints cannot contain duplicates.","TRANSFORMATION_PRESERVATION_INVALID");
 const key=cleanText(idempotencyKey,180);
 if(key.length<8)throw fail("An idempotency key of at least 8 characters is required.","IDEMPOTENCY_KEY_REQUIRED");
 const existing=db.prepare("SELECT * FROM transformation_plans WHERE owner_id=? AND idempotency_key=?").get(ownerId,key);
 const canonical={projectId,sourceAssetId,operation,prompt,durationSeconds:duration,referenceAssetIds:refs,preservation,rightsConfirmed:true,subjectConsentConfirmed:body.subjectConsentConfirmed===true};
 if(existing){
  const same=JSON.stringify({projectId:existing.project_id,sourceAssetId:existing.source_asset_id,operation:existing.operation,prompt:existing.prompt,durationSeconds:existing.duration_seconds,referenceAssetIds:parseJson(existing.reference_asset_ids_json,[]),preservation:parseJson(existing.preservation_json,[]),rightsConfirmed:!!existing.rights_confirmed,subjectConsentConfirmed:!!existing.subject_consent_confirmed})===JSON.stringify(canonical);
  if(!same)throw fail("This idempotency key was already used for a different transformation.","IDEMPOTENCY_CONFLICT",409);
  return {plan:record(existing),idempotentReplay:true};
 }
 const id=randomUUID();
 db.prepare("INSERT INTO transformation_plans(id,owner_id,project_id,source_asset_id,operation,prompt,duration_seconds,reference_asset_ids_json,preservation_json,rights_confirmed,subject_consent_confirmed,status,idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,'draft',?)")
  .run(id,ownerId,projectId,sourceAssetId,operation,prompt,duration,json(refs),json(preservation),1,body.subjectConsentConfirmed===true?1:0,key);
 return {plan:record(db.prepare("SELECT * FROM transformation_plans WHERE id=?").get(id)),idempotentReplay:false};
}

export function approveTransformationPlan(db,{ownerId,planId,body}={}){
 const plan=db.prepare("SELECT * FROM transformation_plans WHERE id=?").get(planId);
 if(!plan||!getProjectAccess(db,ownerId,plan.project_id)||!canWriteProject(db,ownerId,plan.project_id))throw fail("Transformation plan not found or editor access required.","TRANSFORMATION_NOT_FOUND",404);
 if(plan.status!=="draft")throw fail("Only an unapproved draft can be approved.","TRANSFORMATION_STATE_CONFLICT",409);
 const estimate=body?.estimatedCostMicros,budget=body?.approvedBudgetMicros,currency=cleanText(body?.currency,3).toUpperCase();
 const adapterId=cleanText(body?.adapterId,80),capability=cleanText(body?.capability,120);
 if(!Number.isSafeInteger(estimate)||estimate<0||!Number.isSafeInteger(budget)||budget<estimate||! /^[A-Z]{3}$/.test(currency))throw fail("Provide a known non-negative cost estimate, a covering approved budget, and a three-letter currency code.","TRANSFORMATION_BUDGET_INVALID");
 if(!adapterId||!capability)throw fail("Select a declared adapter and capability before approval.","TRANSFORMATION_ADAPTER_REQUIRED");
 const approvalId=randomUUID(),at=new Date().toISOString();
 const changed=db.prepare("UPDATE transformation_plans SET status='approved',approval_id=?,estimated_cost_micros=?,approved_budget_micros=?,currency=?,adapter_id=?,capability=?,approved_at=?,updated_at=? WHERE id=? AND status='draft'")
  .run(approvalId,estimate,budget,currency,adapterId,capability,at,at,plan.id);
 if(changed.changes!==1)throw fail("Transformation plan changed while approval was being recorded.","TRANSFORMATION_STATE_CONFLICT",409);
 return record(db.prepare("SELECT * FROM transformation_plans WHERE id=?").get(plan.id));
}

export function listTransformationPlans(db,ownerId,projectId){
 if(!getProjectAccess(db,ownerId,projectId))throw fail("Project not found.","PROJECT_NOT_FOUND",404);
 return db.prepare("SELECT * FROM transformation_plans WHERE project_id=? ORDER BY created_at DESC LIMIT 100").all(projectId).map(record);
}

export function getTransformationPlan(db,ownerId,planId){
 const row=db.prepare("SELECT * FROM transformation_plans WHERE id=?").get(planId);
 if(!row||!getProjectAccess(db,ownerId,row.project_id))throw fail("Transformation plan not found.","TRANSFORMATION_NOT_FOUND",404);
 return record(row);
}
