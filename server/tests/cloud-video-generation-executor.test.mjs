import test from "node:test";
import assert from "node:assert/strict";
import { createCloudVideoGenerationExecutor } from "../cloud-video-generation-executor.mjs";

const job={id:"job-1",owner_id:"owner-1",project_id:"project-1",job_type:"video.generate.shot",input:{approvalId:"approval-1",shotIndex:0}};
const approval={id:"approval-1",ownerId:"owner-1",projectId:"project-1",status:"approved_pending_submission",currency:"USD",budgetCeilingMicros:5000000,requestHash:"a".repeat(64),shots:[{provider:"runway",model:"seedance2_5",prompt:"A cinematic sunrise",durationSeconds:5,aspectRatio:"16:9",estimatedCostMicros:2500000,name:"sunrise"}]};
const mp4=Buffer.concat([Buffer.from("0000ftyp"),Buffer.alloc(32)]);
function fixture({taskState="reserved",providerTaskId=null,providerStatus="SUCCEEDED"}={}){
 const calls=[],record={id:"task-1",state:taskState,providerTaskId};
 const tasks={
  async reserveSubmission(input){calls.push(["reserve",input]);return record;},
  async markSubmitting(id){calls.push(["submitting",id]);record.state="submitting";},
  async markSubmitted(id,value){calls.push(["submitted",value]);record.state="submitted";record.providerTaskId=value.providerTaskId;},
  async markSubmissionUnknown(id,value){calls.push(["unknown",value]);record.state="submission_unknown";},
  async markProcessing(id,value){calls.push(["processing",value]);record.state="processing";},
  async markFailed(id,value){calls.push(["failed",value]);record.state="failed";},
  async markSucceeded(id,value){calls.push(["succeeded",value]);record.state="succeeded";}
 };
 const approvals={async get(id){calls.push(["approval",id]);return approval;}};
 const mediaIO={async publish(value){calls.push(["publish",value]);return{id:"asset-1",...value};}};
 const execute=createCloudVideoGenerationExecutor({
  approvals,tasks,mediaIO,
  submitTask:async value=>{calls.push(["submit",value]);return{taskId:"123e4567-e89b-42d3-a456-426614174000",estimatedCostCredits:25};},
  getTask:async value=>{calls.push(["poll",value]);return{taskId:value.taskId,status:providerStatus,outputUrl:"https://cdn.example.cloudfront.net/video.mp4"};},
  downloadOutput:async value=>{calls.push(["download",value]);return mp4;},
  sleepImpl:async()=>{}
 });
 return{execute,calls,record};
}
test("approved shot submits once, persists task ID, downloads and publishes private MP4",async()=>{
 const f=fixture();
 const result=await f.execute({job});
 assert.equal(result.providerTaskId,"123e4567-e89b-42d3-a456-426614174000");
 assert.equal(result.outputAsset.id,"asset-1");
 assert.equal(f.calls.filter(x=>x[0]==="submit").length,1);
 assert.equal(f.calls.filter(x=>x[0]==="submitted").length,1);
 assert.equal(f.calls.filter(x=>x[0]==="publish").length,1);
 assert.equal(f.record.state,"succeeded");
});
test("ambiguous previous submission never creates another provider task",async()=>{
 const f=fixture({taskState:"submission_unknown"});
 await assert.rejects(()=>f.execute({job}),e=>e.code==="VIDEO_GATEWAY_SUBMISSION_UNKNOWN");
 assert.equal(f.calls.filter(x=>x[0]==="submit").length,0);
});
test("recovered task with persisted provider ID resumes polling without POST",async()=>{
 const f=fixture({taskState:"submitted",providerTaskId:"123e4567-e89b-42d3-a456-426614174000"});
 const result=await f.execute({job});
 assert.equal(result.outputAsset.id,"asset-1");
 assert.equal(f.calls.filter(x=>x[0]==="submit").length,0);
 assert.ok(f.calls.some(x=>x[0]==="poll"));
});
test("approval owner and project are checked before task reservation",async()=>{
 const f=fixture();
 const wrong={...job,owner_id:"other-owner"};
 await assert.rejects(()=>f.execute({job:wrong}),e=>e.code==="VIDEO_APPROVAL_SCOPE_INVALID");
 assert.equal(f.calls.filter(x=>x[0]==="reserve").length,0);
});
test("terminal provider failure is recorded and does not publish an asset",async()=>{
 const f=fixture({providerStatus:"FAILED"});
 await assert.rejects(()=>f.execute({job}),e=>e.code==="VIDEO_PROVIDER_TASK_FAILED");
 assert.equal(f.calls.filter(x=>x[0]==="publish").length,0);
 assert.equal(f.record.state,"failed");
});
