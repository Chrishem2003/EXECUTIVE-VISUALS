import { createHash, randomUUID } from "node:crypto";
import { addJobEvent, audit, json, parseJson } from "./db.mjs";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const now=()=>new Date().toISOString();

function transitionToQueued({db,row,cloudJobId}){
 return db.transaction(()=>{
  const run=db.prepare("SELECT * FROM workflow_runs WHERE id=?").get(row.run_id);
  const node=db.prepare("SELECT status,output_json,error_json FROM workflow_node_runs WHERE run_id=? AND node_id=?").get(row.run_id,row.node_id);
  const output=parseJson(node?.output_json,{});
  const error=parseJson(node?.error_json,{});
  if(run?.status!=="blocked"||node?.status!=="blocked"||error.code!=="CLOUD_VIDEO_JOB_PENDING"||output.cloudJobId!==cloudJobId)return false;
  const parkedJob=db.prepare("SELECT status FROM jobs WHERE id=?").get(run.job_id);
  if(parkedJob?.status!=="blocked")return false;
  const key="workflow-resume-"+createHash("sha256").update(run.id+":"+row.node_id+":"+cloudJobId).digest("hex");
  const existing=db.prepare("SELECT id FROM jobs WHERE owner_id=? AND idempotency_key=?").get(run.owner_id,key);
  const updatedNode=db.prepare("UPDATE workflow_node_runs SET status='pending',error_json=NULL,completed_at=NULL WHERE run_id=? AND node_id=? AND status='blocked'")
   .run(run.id,row.node_id);
  if(updatedNode.changes!==1)return false;
  const jobId=existing?.id||randomUUID();
  if(!existing){
   db.prepare("INSERT INTO jobs(id,owner_id,project_id,job_type,status,progress,input_json,idempotency_key) VALUES(?,?,?,'workflow.execute','queued',0,?,?)")
    .run(jobId,run.owner_id,run.project_id,json({runId:run.id}),key);
  }
  const updatedRun=db.prepare("UPDATE workflow_runs SET status='queued',job_id=?,error_json=NULL,updated_at=?,completed_at=NULL WHERE id=? AND status='blocked'")
   .run(jobId,now(),run.id);
  if(updatedRun.changes!==1)throw new Error("Workflow run changed while resuming its completed cloud video job.");
  if(!existing)addJobEvent(db,jobId,run.owner_id,"job.queued",{jobType:"workflow.execute",runId:run.id,resumedCloudVideoJobId:cloudJobId,nodeId:row.node_id});
  audit(db,run.owner_id,"workflow.cloud_video_resumed","workflow_run",run.id,{nodeId:row.node_id,cloudJobId,jobId},run.project_id);
  return true;
 })();
}

function transitionToTerminal({db,row,cloudJob,status,message}){
 return db.transaction(()=>{
  const run=db.prepare("SELECT * FROM workflow_runs WHERE id=?").get(row.run_id);
  const node=db.prepare("SELECT status,output_json,error_json FROM workflow_node_runs WHERE run_id=? AND node_id=?").get(row.run_id,row.node_id);
  const output=parseJson(node?.output_json,{});
  const error=parseJson(node?.error_json,{});
  if(run?.status!=="blocked"||node?.status!=="blocked"||error.code!=="CLOUD_VIDEO_JOB_PENDING"||output.cloudJobId!==cloudJob.id)return false;
  const nextCode=status==="needs_input"?"VIDEO_WORKFLOW_CLOUD_JOB_NEEDS_INPUT":"VIDEO_WORKFLOW_CLOUD_JOB_FAILED";
  const detail={code:nextCode,message:String(message||"Cloud video job ended with status "+status).slice(0,500),cloudJobId:cloudJob.id};
  const cancelled=status==="cancelled"||status==="canceled";
  const localStatus=cancelled?"cancelled":status==="needs_input"?"needs_input":"failed";
  const timestamp=now();
  // Keep the durable local job row in sync with its terminal cloud workflow state.
  // The parked job must still be blocked; never overwrite a job reclaimed elsewhere.
  const parked=db.prepare("UPDATE jobs SET status=?,error_json=?,updated_at=?,completed_at=?,available_at=NULL,lease_owner=NULL,lease_expires_at=NULL,lease_heartbeat_at=NULL WHERE id=? AND status='blocked'")
   .run(localStatus,json(detail),timestamp,timestamp,run.job_id);
  if(parked.changes!==1)return false;
  const nodeUpdate=cancelled
   ?db.prepare("UPDATE workflow_node_runs SET status='skipped',error_json=?,completed_at=? WHERE run_id=? AND node_id=? AND status='blocked'").run(json(detail),timestamp,run.id,row.node_id)
   :db.prepare("UPDATE workflow_node_runs SET status=?,error_json=?,completed_at=? WHERE run_id=? AND node_id=? AND status='blocked'").run(status==="needs_input"?"blocked":"failed",json(detail),timestamp,run.id,row.node_id);
  if(nodeUpdate.changes!==1)throw new Error("Workflow node changed while recording its terminal cloud video result.");
  const runUpdate=cancelled
   ?db.prepare("UPDATE workflow_runs SET status='cancelled',error_json=?,updated_at=?,completed_at=? WHERE id=? AND status='blocked'").run(json(detail),timestamp,timestamp,run.id)
   :db.prepare("UPDATE workflow_runs SET status=?,error_json=?,updated_at=?,completed_at=? WHERE id=? AND status='blocked'").run(status==="needs_input"?"blocked":"failed",json(detail),timestamp,status==="needs_input"?null:timestamp,run.id);
  if(runUpdate.changes!==1)throw new Error("Workflow run changed while recording its terminal cloud video result.");
  addJobEvent(db,run.job_id,run.owner_id,"job."+localStatus,{cloudJobId:cloudJob.id,workflowRunId:run.id,nodeId:row.node_id,code:detail.code});
  audit(db,run.owner_id,"workflow.cloud_video_terminal","workflow_run",run.id,{nodeId:row.node_id,cloudJobId:cloudJob.id,status,localJobStatus:localStatus,code:detail.code},run.project_id);
  return true;
 })();
}

/**
 * Polls only workflow nodes explicitly paused on a durable cloud video job.
 * A successful cloud job requeues the local workflow so the executor can
 * import the existing job's private outputs and continue downstream nodes.
 */
export async function resumeCompletedCloudVideoWorkflows({db,cloudTimelineApi,limit=50,onError=()=>{}}={}){
 if(!db||!cloudTimelineApi||typeof cloudTimelineApi.handle!=="function")return{scanned:0,resumed:0,terminal:0};
 if(!Number.isInteger(limit)||limit<1||limit>500)throw new Error("Cloud workflow resume limit must be between 1 and 500.");
 const rows=db.prepare("SELECT n.run_id,n.node_id,n.output_json,n.error_json,r.owner_id,r.project_id,r.status FROM workflow_node_runs n JOIN workflow_runs r ON r.id=n.run_id WHERE n.status='blocked' AND r.status='blocked' ORDER BY r.updated_at ASC LIMIT ?").all(limit);
 let resumed=0,terminal=0;
 for(const row of rows){
  const error=parseJson(row.error_json,{});
  const output=parseJson(row.output_json,{});
  const cloudJobId=String(output.cloudJobId||"");
  if(error.code!=="CLOUD_VIDEO_JOB_PENDING"||!UUID.test(cloudJobId))continue;
  try{
   const result=await cloudTimelineApi.handle({method:"GET",path:"/api/cloud/jobs/"+cloudJobId,ownerId:row.owner_id});
   if(result?.status!==200)continue;
   const cloudJob=result.body?.job;
   if(!cloudJob||cloudJob.id!==cloudJobId)continue;
   if(cloudJob.status==="succeeded"){
    if(transitionToQueued({db,row,cloudJobId}))resumed++;
   }else if(["failed","needs_input","cancelled","canceled"].includes(String(cloudJob.status))){
    if(transitionToTerminal({db,row,cloudJob,status:String(cloudJob.status),message:cloudJob.error?.message}))terminal++;
   }
  }catch(error){onError(error,{runId:row.run_id,nodeId:row.node_id,cloudJobId});}
 }
 return{scanned:rows.length,resumed,terminal};
}
