import test from "node:test";
import assert from "node:assert/strict";
import { createKieSeedanceClient } from "../kie-seedance-client.mjs";

const TASK_ID="task_bytedance_1765186743319";
const success=()=>new Response(JSON.stringify({code:200,msg:"success",data:{taskId:TASK_ID}}),{status:200});

test("submits exact Seedance 2.0 tasks with server-only bearer authentication",async()=>{
 let request;
 const client=createKieSeedanceClient({apiKey:"kie-secret-test",model:"bytedance/seedance-2",fetchImpl:async(url,init)=>{request={url,init};return success();}});
 const result=await client.submit({prompt:"A carefully directed scene",duration:5,resolution:"720p"});
 assert.equal(result.taskId,TASK_ID);
 assert.equal(result.status,"queued");
 assert.equal(request.url,"https://api.kie.ai/api/v1/jobs/createTask");
 assert.equal(request.init.headers.authorization,"Bearer kie-secret-test");
 assert.equal(JSON.parse(request.init.body).model,"bytedance/seedance-2");
 assert.deepEqual(JSON.parse(request.init.body).input,{prompt:"A carefully directed scene",duration:5,resolution:"720p"});
});

test("normalizes Kie task states and extracts authoritative output and credit usage",async()=>{
 const client=createKieSeedanceClient({apiKey:"test",fetchImpl:async()=>new Response(JSON.stringify({code:200,data:{taskId:TASK_ID,state:"success",creditsConsumed:205,costTime:72,resultJson:JSON.stringify({resultUrls:["https://cdn.example.com/video.mp4"]})}}),{status:200})});
 const result=await client.getStatus(TASK_ID);
 assert.equal(result.status,"succeeded");
 assert.equal(result.creditsConsumed,205);
 assert.equal(result.usage.costTimeSeconds,72);
 assert.deepEqual(result.outputUrls,["https://cdn.example.com/video.mp4"]);
});

test("maps queued, running and failed provider states without inventing success",async()=>{
 const states=["waiting","queuing","generating","fail"];
 const expected=["queued","queued","running","failed"];
 for(let i=0;i<states.length;i++){
  const client=createKieSeedanceClient({apiKey:"test",fetchImpl:async()=>new Response(JSON.stringify({code:200,data:{taskId:TASK_ID,state:states[i],failMsg:"moderation rejected"}}),{status:200})});
  const result=await client.getStatus(TASK_ID);
  assert.equal(result.status,expected[i]);
 }
});

test("rejects task mismatch, malformed output URLs and unsupported model IDs",async()=>{
 const bad=createKieSeedanceClient({apiKey:"test",fetchImpl:async()=>new Response(JSON.stringify({code:200,data:{taskId:"task_other_123456",state:"success",resultJson:{resultUrls:["https://cdn.example.com/out.mp4"]}}}),{status:200})});
 await assert.rejects(bad.getStatus(TASK_ID),error=>error.code==="KIE_RESPONSE_INVALID");
 const unsafe=createKieSeedanceClient({apiKey:"test",fetchImpl:async()=>new Response(JSON.stringify({code:200,data:{taskId:TASK_ID,state:"success",resultJson:{resultUrls:["https://127.0.0.1/private.mp4"]}}}),{status:200})});
 await assert.rejects(unsafe.getStatus(TASK_ID),error=>error.code==="KIE_OUTPUT_URL_REJECTED");
 assert.throws(()=>createKieSeedanceClient({apiKey:"test",model:"unlisted-model"}),error=>error.code==="KIE_MODEL_UNSUPPORTED");
});

test("treats ambiguous submit timeouts as unknown rather than retryable failures",async()=>{
 const client=createKieSeedanceClient({apiKey:"test",timeoutMs:1000,fetchImpl:async()=>{const error=new Error("network reset");error.name="AbortError";throw error;}});
 await assert.rejects(client.submit({prompt:"paid task"}),error=>error.code==="KIE_SUBMISSION_UNKNOWN");
});

test("fails closed on missing credentials and provider credit exhaustion",async()=>{
 assert.throws(()=>createKieSeedanceClient({apiKey:""}),error=>error.code==="KIE_CONFIGURATION_MISSING");
 const client=createKieSeedanceClient({apiKey:"test",fetchImpl:async()=>new Response(JSON.stringify({code:402,msg:"insufficient credits"}),{status:200})});
 await assert.rejects(client.submit({prompt:"paid task"}),error=>error.code==="KIE_CREDITS_INSUFFICIENT");
});
