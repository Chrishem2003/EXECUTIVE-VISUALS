const ADMIN_EMAILS_ENV="ADMIN_EMAILS";
export function isPlatformAdministrator(user,env=process.env){
 const allowed=new Set(String(env[ADMIN_EMAILS_ENV]||env.AI_UPSCALE_ADMIN_EMAILS||"").split(",").map(value=>value.trim().toLowerCase()).filter(Boolean));
 return Boolean(user?.email&&allowed.has(String(user.email).trim().toLowerCase()));
}
const boundedLimit=value=>{const parsed=value===null||value===undefined||value===""?100:Number(value);return Math.max(1,Math.min(200,Number.isFinite(parsed)?Math.trunc(parsed):100));};
export function getAdminOperationsOverview(db,{authMode="unknown",dataPersistence="unknown",persistentDataRequired=false,now=Date.now()}={}){
 const counts=db.prepare("SELECT (SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM projects) AS projects,(SELECT COUNT(*) FROM assets WHERE deleted_at IS NULL) AS assets,(SELECT COUNT(*) FROM jobs) AS jobs").get();
 const jobs=db.prepare("SELECT status,COUNT(*) AS count FROM jobs GROUP BY status").all();
 const usage=db.prepare("SELECT COUNT(*) AS operations,COALESCE(SUM(estimated_cost_micros),0) AS estimatedCostMicros FROM model_usage_events WHERE created_at>=?").get(new Date(now-30*24*60*60*1000).toISOString());
 return {users:Number(counts.users||0),projects:Number(counts.projects||0),assets:Number(counts.assets||0),jobs:Number(counts.jobs||0),jobsByStatus:Object.fromEntries(jobs.map(row=>[String(row.status),Number(row.count||0)])),usage30d:{operations:Number(usage.operations||0),estimatedCostMicros:Number(usage.estimatedCostMicros||0)},generatedAt:new Date(now).toISOString(),runtime:{authMode,dataPersistence,persistentDataRequired:Boolean(persistentDataRequired)}};
}
function escapeLikeQuery(value){return String(value||"").trim().slice(0,120).replace(/[\\%_]/g,"\\$&");}
export function listAdminOperationUsers(db,{query="",limit=100}={}){
 const q=escapeLikeQuery(query),n=boundedLimit(limit);
 return db.prepare(`SELECT u.id,u.email,u.auth_source,u.created_at,
 (SELECT COUNT(*) FROM projects p WHERE p.owner_id=u.id) AS projects,
 (SELECT COUNT(*) FROM jobs j WHERE j.owner_id=u.id) AS jobs,
 (SELECT COUNT(*) FROM model_usage_events m WHERE m.owner_id=u.id AND m.created_at>=?) AS usage30d
 FROM users u WHERE (?='' OR u.email LIKE '%'||?||'%' ESCAPE '\\' OR u.id LIKE '%'||?||'%' ESCAPE '\\')
 ORDER BY u.created_at DESC LIMIT ?`).all(new Date(Date.now()-30*24*60*60*1000).toISOString(),q,q,q,n).map(row=>({id:row.id,email:row.email,authSource:row.auth_source,createdAt:row.created_at,projects:Number(row.projects||0),jobs:Number(row.jobs||0),usage30d:Number(row.usage30d||0)}));
}
export function listAdminOperationJobs(db,{limit=100}={}){
 return db.prepare(`SELECT j.id,u.email,j.job_type,j.status,j.progress,j.attempt_count,j.created_at,j.updated_at,j.completed_at
 FROM jobs j LEFT JOIN users u ON u.id=j.owner_id ORDER BY j.created_at DESC LIMIT ?`).all(boundedLimit(limit)).map(row=>({id:row.id,email:row.email||"Unknown account",jobType:row.job_type,status:row.status,progress:Number(row.progress||0),attempts:Number(row.attempt_count||0),createdAt:row.created_at,updatedAt:row.updated_at,completedAt:row.completed_at||null}));
}

const ADMIN_PROVIDER_MODEL_FIELDS=["id","label","readiness","available","executionVerified","qualityVerified","reason","resolutions","aspectRatios","inputModes","minDurationSeconds","maxDurationSeconds"];
const ADMIN_PROVIDER_CAPABILITY_FIELDS=["startFrame","endFrame","referenceImages","audioModes","resolutions","aspectRatios","minDurationSeconds","maxDurationSeconds"];
const safeArray=(value)=>Array.isArray(value)?value.filter(item=>typeof item==="string"||typeof item==="number"||typeof item==="boolean").slice(0,40):[];
function adminProviderModel(model){
 if(!model||typeof model!=="object"||Array.isArray(model))return null;
 const result={};
 for(const key of ADMIN_PROVIDER_MODEL_FIELDS){
  const value=model[key];
  if(value===undefined||value===null)continue;
  if(["resolutions","aspectRatios","inputModes"].includes(key))result[key]=safeArray(value);
  else if(["available","executionVerified","qualityVerified"].includes(key))result[key]=Boolean(value);
  else if(["minDurationSeconds","maxDurationSeconds"].includes(key)&&Number.isFinite(Number(value)))result[key]=Number(value);
  else if(typeof value==="string")result[key]=value.slice(0,500);
 }
 return Object.keys(result).length?result:null;
}
export function buildAdminProviderReadiness(catalog){
 const providers=Array.isArray(catalog?.providers)?catalog.providers:[];
 return providers.slice(0,40).map(item=>{
  const models=Array.isArray(item.availableModels)?item.availableModels.map(adminProviderModel).filter(Boolean):[];
  const rawCapabilities=item.modelCapabilities&&typeof item.modelCapabilities==="object"&&!Array.isArray(item.modelCapabilities)?item.modelCapabilities:null;
  const modelCapabilities=rawCapabilities?Object.fromEntries(ADMIN_PROVIDER_CAPABILITY_FIELDS.filter(key=>rawCapabilities[key]!==undefined).flatMap(key=>{const value=rawCapabilities[key];if(["audioModes","resolutions","aspectRatios"].includes(key))return [[key,safeArray(value)]];if(["minDurationSeconds","maxDurationSeconds"].includes(key))return Number.isFinite(Number(value))?[[key,Number(value)]]:[];return typeof value==="boolean"?[[key,value]]:[]})):null;
  const rawPricing=item.pricing&&typeof item.pricing==="object"?item.pricing:null;
  const pricing=rawPricing?{
   configured:Boolean(rawPricing.configured),
   rejectedCount:Number.isFinite(Number(rawPricing.rejectedCount))?Math.max(0,Number(rawPricing.rejectedCount)):0,
   models:(Array.isArray(rawPricing.models)?rawPricing.models:[]).slice(0,100).map(model=>({
    provider:String(model.provider||"").slice(0,80),
    model:String(model.model||"").slice(0,160),
    currency:String(model.currency||"").slice(0,12),
    sourceUrl:(()=>{try{const url=new URL(String(model.sourceUrl||""));return url.protocol==="https:"&&!url.username&&!url.password&&!url.search&&!url.hash?url.toString().slice(0,500):"";}catch{return "";}})(),
    observedAt:String(model.observedAt||"").slice(0,80),
    expiresAt:String(model.expiresAt||"").slice(0,80)
   }))
  }:null;
  return {
   id:String(item.id||"").slice(0,80),
   provider:String(item.provider||"").slice(0,80),
   status:String(item.status||"unavailable").slice(0,80),
   enabled:Boolean(item.enabled),
   configured:Boolean(item.configured),
   remote:Boolean(item.remote),
   model:typeof item.model==="string"?item.model.slice(0,160):null,
   reason:String(item.reason||"").slice(0,500),
   capabilities:safeArray(item.capabilities),
   availableModels:models,
   modelCapabilities,
   pricing
  };
 });
}

export function listAdminOperationAudit(db,{limit=100}={}){
 return db.prepare(`SELECT a.id,a.owner_id,u.email,a.event_type,a.subject_type,a.subject_id,a.created_at
 FROM audit_events a LEFT JOIN users u ON u.id=a.owner_id ORDER BY a.id DESC LIMIT ?`).all(boundedLimit(limit)).map(row=>({id:Number(row.id),ownerId:row.owner_id,email:row.email||"Unknown account",eventType:row.event_type,subjectType:row.subject_type,subjectId:row.subject_id,createdAt:row.created_at}));
}

export function buildAdminProviderReadinessSummary(providers){
 const rows=Array.isArray(providers)?providers:[];
 const summary={total:rows.length,ready:0,disabled:0,unverified:0,needsConfiguration:0,remoteOptInRequired:0,unavailable:0,models:0,qualityVerifiedModels:0};
 for(const provider of rows){
  const status=String(provider?.status||"unavailable");
  if(status==="ready")summary.ready++;
  else if(status==="disabled")summary.disabled++;
  else if(status==="unverified")summary.unverified++;
  else if(status==="needs_configuration")summary.needsConfiguration++;
  else if(status==="remote_opt_in_required")summary.remoteOptInRequired++;
  else if(status==="unavailable")summary.unavailable++;
  const models=Array.isArray(provider?.availableModels)?provider.availableModels:[];
  summary.models+=models.length;
  summary.qualityVerifiedModels+=models.filter(model=>model?.qualityVerified===true).length;
 }
 return summary;
}
