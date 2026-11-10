const ADMIN_EMAILS_ENV="ADMIN_EMAILS";
export function isPlatformAdministrator(user,env=process.env){
 const allowed=new Set(String(env[ADMIN_EMAILS_ENV]||env.AI_UPSCALE_ADMIN_EMAILS||"").split(",").map(value=>value.trim().toLowerCase()).filter(Boolean));
 return Boolean(user?.email&&allowed.has(String(user.email).trim().toLowerCase()));
}
const boundedLimit=value=>Math.max(1,Math.min(200,Number.isFinite(Number(value))?Math.trunc(Number(value)):100));
export function getAdminOperationsOverview(db,{authMode="unknown",dataPersistence="unknown",persistentDataRequired=false,now=Date.now()}={}){
 const counts=db.prepare("SELECT (SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM projects) AS projects,(SELECT COUNT(*) FROM assets WHERE deleted_at IS NULL) AS assets,(SELECT COUNT(*) FROM jobs) AS jobs").get();
 const jobs=db.prepare("SELECT status,COUNT(*) AS count FROM jobs GROUP BY status").all();
 const usage=db.prepare("SELECT COUNT(*) AS operations,COALESCE(SUM(estimated_cost_micros),0) AS estimatedCostMicros FROM model_usage_events WHERE created_at>=?").get(new Date(now-30*24*60*60*1000).toISOString());
 return {users:Number(counts.users||0),projects:Number(counts.projects||0),assets:Number(counts.assets||0),jobs:Number(counts.jobs||0),jobsByStatus:Object.fromEntries(jobs.map(row=>[String(row.status),Number(row.count||0)])),usage30d:{operations:Number(usage.operations||0),estimatedCostMicros:Number(usage.estimatedCostMicros||0)},generatedAt:new Date(now).toISOString(),runtime:{authMode,dataPersistence,persistentDataRequired:Boolean(persistentDataRequired)}};
}
export function listAdminOperationUsers(db,{query="",limit=100}={}){
 const q=String(query||"").trim().slice(0,120),n=boundedLimit(limit);
 return db.prepare(`SELECT u.id,u.email,u.auth_source,u.created_at,
 (SELECT COUNT(*) FROM projects p WHERE p.owner_id=u.id) AS projects,
 (SELECT COUNT(*) FROM jobs j WHERE j.owner_id=u.id) AS jobs,
 (SELECT COUNT(*) FROM model_usage_events m WHERE m.owner_id=u.id AND m.created_at>=?) AS usage30d
 FROM users u WHERE (?='' OR u.email LIKE '%'||?||'%' OR u.id LIKE '%'||?||'%')
 ORDER BY u.created_at DESC LIMIT ?`).all(q,q,q,new Date(Date.now()-30*24*60*60*1000).toISOString(),n).map(row=>({id:row.id,email:row.email,authSource:row.auth_source,createdAt:row.created_at,projects:Number(row.projects||0),jobs:Number(row.jobs||0),usage30d:Number(row.usage30d||0)}));
}
export function listAdminOperationJobs(db,{limit=100}={}){
 return db.prepare(`SELECT j.id,u.email,j.job_type,j.status,j.progress,j.attempt_count,j.created_at,j.updated_at,j.completed_at
 FROM jobs j LEFT JOIN users u ON u.id=j.owner_id ORDER BY j.created_at DESC LIMIT ?`).all(boundedLimit(limit)).map(row=>({id:row.id,email:row.email||"Unknown account",jobType:row.job_type,status:row.status,progress:Number(row.progress||0),attempts:Number(row.attempt_count||0),createdAt:row.created_at,updatedAt:row.updated_at,completedAt:row.completed_at||null}));
}
export function listAdminOperationAudit(db,{limit=100}={}){
 return db.prepare(`SELECT a.id,a.owner_id,u.email,a.event_type,a.subject_type,a.subject_id,a.created_at
 FROM audit_events a LEFT JOIN users u ON u.id=a.owner_id ORDER BY a.id DESC LIMIT ?`).all(boundedLimit(limit)).map(row=>({id:Number(row.id),ownerId:row.owner_id,email:row.email||"Unknown account",eventType:row.event_type,subjectType:row.subject_type,subjectId:row.subject_id,createdAt:row.created_at}));
}
