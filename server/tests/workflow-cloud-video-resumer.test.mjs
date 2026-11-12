import test from "node:test";
import assert from "node:assert/strict";
import { resumeCompletedCloudVideoWorkflows } from "../workflow-cloud-video-resumer.mjs";

const owner="123e4567-e89b-42d3-a456-426614174000";
const project="423e4567-e89b-42d3-a456-426614174000";
const runId="523e4567-e89b-42d3-a456-426614174000";
const nodeId="video-node";
const cloudJobId="623e4567-e89b-42d3-a456-426614174000";

function fixture(cloudStatus="succeeded",originalJobStatus="blocked"){
 const run={id:runId,owner_id:owner,project_id:project,status:"blocked",job_id:"old-local-job"};
 const node={status:"blocked",output_json:JSON.stringify({cloudJobId}),error_json:JSON.stringify({code:"CLOUD_VIDEO_JOB_PENDING"})};
 const parkedJob={status:originalJobStatus};
 const jobs=[],events=[],audits=[];
 const db={
  transaction(fn){return()=>fn();},
  prepare(sql){
   if(sql.startsWith("SELECT n.run_id"))return{all:()=>node.status==="blocked"&&run.status==="blocked"?[{run_id:runId,node_id:nodeId,owner_id:owner,project_id:project,status:"blocked",output_json:node.output_json,error_json:node.error_json}]:[]};
   if(sql.startsWith("SELECT status FROM jobs WHERE id=?"))return{get:()=>({status:parkedJob.status})};
   if(sql.startsWith("UPDATE jobs SET status=?"))return{run(status){if(parkedJob.status!=="blocked")return{changes:0};parkedJob.status=status;return{changes:1};}};
   if(sql.startsWith("SELECT * FROM workflow_runs"))return{get:()=>({...run})};
   if(sql.startsWith("SELECT status,output_json,error_json FROM workflow_node_runs"))return{get:()=>({...node})};
   if(sql.startsWith("SELECT id FROM jobs WHERE owner_id"))return{get:(ownerId,key)=>jobs.find(job=>job.owner_id===ownerId&&job.idempotency_key===key)||null};
   if(sql.startsWith("INSERT INTO jobs"))return{run(...args){jobs.push({id:args[0],owner_id:args[1],project_id:args[2],idempotency_key:args[4]});}};
   if(sql.startsWith("UPDATE workflow_node_runs SET status='pending'"))return{run(){if(node.status!=="blocked")return{changes:0};node.status="pending";node.error_json=null;return{changes:1};}};
   if(sql.startsWith("UPDATE workflow_runs SET status='queued'"))return{run(...args){if(run.status!=="blocked")return{changes:0};run.status="queued";run.job_id=args[0];run.error_json=null;return{changes:1};}};
   if(sql.startsWith("UPDATE workflow_node_runs SET status=?"))return{run(...args){node.status=args[0];node.error_json=args[1];return{changes:1};}};
   if(sql.startsWith("UPDATE workflow_runs SET status=?"))return{run(...args){run.status=args[0];run.error_json=args[1];return{changes:1};}};
   if(sql.startsWith("INSERT INTO job_events"))return{run(...args){events.push(args);}};
   if(sql.startsWith("INSERT INTO audit_events"))return{run(...args){audits.push(args);}};
   throw new Error("Unexpected SQL: "+sql);
  }
 };
 const cloudTimelineApi={async handle(input){assert.equal(input.ownerId,owner);assert.equal(input.path,"/api/cloud/jobs/"+cloudJobId);return{status:200,body:{job:{id:cloudJobId,status:cloudStatus,error:{message:"Provider rejected the request."}}}};}};
 return{db,run,node,parkedJob,jobs,events,audits,cloudTimelineApi};
}

test("completed cloud job requeues the blocked workflow exactly once",async()=>{
 const f=fixture();
 const first=await resumeCompletedCloudVideoWorkflows({db:f.db,cloudTimelineApi:f.cloudTimelineApi});
 assert.deepEqual(first,{scanned:1,resumed:1,terminal:0});
 assert.equal(f.run.status,"queued");
 assert.equal(f.node.status,"pending");
 assert.equal(f.jobs.length,1);
 assert.equal(f.events.length,1);
 assert.equal(f.audits.length,1);
 const second=await resumeCompletedCloudVideoWorkflows({db:f.db,cloudTimelineApi:f.cloudTimelineApi});
 assert.deepEqual(second,{scanned:0,resumed:0,terminal:0});
 assert.equal(f.jobs.length,1);
});

test("failed cloud job terminalizes the blocked workflow without requeueing",async()=>{
 const f=fixture("failed");
 const result=await resumeCompletedCloudVideoWorkflows({db:f.db,cloudTimelineApi:f.cloudTimelineApi});
 assert.deepEqual(result,{scanned:1,resumed:0,terminal:1});
 assert.equal(f.run.status,"failed");
 assert.equal(f.node.status,"failed");
 assert.equal(f.parkedJob.status,"failed");
 assert.equal(f.events.length,1);
 assert.equal(f.events[0][2],"job.failed");
 assert.equal(f.jobs.length,0);
});

test("cancelled cloud job closes the parked local job and workflow",async()=>{
 const f=fixture("cancelled");
 const result=await resumeCompletedCloudVideoWorkflows({db:f.db,cloudTimelineApi:f.cloudTimelineApi});
 assert.deepEqual(result,{scanned:1,resumed:0,terminal:1});
 assert.equal(f.run.status,"cancelled");
 assert.equal(f.node.status,"skipped");
 assert.equal(f.parkedJob.status,"cancelled");
 assert.equal(f.events.length,1);
 assert.equal(f.events[0][2],"job.cancelled");
 assert.equal(f.jobs.length,0);
});

test("running cloud job leaves the workflow parked without creating local jobs",async()=>{
 const f=fixture("running");
 const result=await resumeCompletedCloudVideoWorkflows({db:f.db,cloudTimelineApi:f.cloudTimelineApi});
 assert.deepEqual(result,{scanned:1,resumed:0,terminal:0});
 assert.equal(f.run.status,"blocked");
 assert.equal(f.jobs.length,0);
});

test("does not requeue while the original local workflow worker still owns its job",async()=>{
 const f=fixture("succeeded","running");
 const result=await resumeCompletedCloudVideoWorkflows({db:f.db,cloudTimelineApi:f.cloudTimelineApi});
 assert.deepEqual(result,{scanned:1,resumed:0,terminal:0});
 assert.equal(f.run.status,"blocked");
 assert.equal(f.node.status,"blocked");
 assert.equal(f.jobs.length,0);
});
