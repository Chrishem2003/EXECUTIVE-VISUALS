import test from "node:test";
import assert from "node:assert/strict";
import {createBatchIdempotencyKeys,inspectBatchReplay} from "../batch-idempotency.mjs";

const items=[
 {sourceAssetId:"asset-a",model:"realesrgan-x4plus",scale:4,tile:0,format:"png",index:0},
 {sourceAssetId:"asset-b",model:"realesrgan-x4plus",scale:4,tile:0,format:"png",index:1}
];
function jobs(batchId="batch-1"){
 return items.map((item,index)=>({
  job_type:"media.ai-upscale",project_id:"project-1",
  input_json:JSON.stringify({...item,batchId,batchIndex:index,batchTotal:items.length})
 }));
}

test("batch idempotency keys are deterministic, namespaced and bounded",()=>{
 const first=createBatchIdempotencyKeys("request-1",2);
 assert.deepEqual(first,createBatchIdempotencyKeys("request-1",2));
 assert.notDeepEqual(first,createBatchIdempotencyKeys("request-2",2));
 assert.equal(first.length,2);
 assert.equal(new Set(first).size,2);
 assert.deepEqual(createBatchIdempotencyKeys("",2),[]);
 assert.throws(()=>createBatchIdempotencyKeys("request-1",101),/between 1 and 100/);
});

test("a complete matching batch replays its original batch identity",()=>{
 const result=inspectBatchReplay(jobs("original-batch"),items,"project-1");
 assert.deepEqual(result,{exists:true,matches:true,batchId:"original-batch"});
});

test("partial, cross-project or changed batches conflict instead of duplicating work",()=>{
 assert.equal(inspectBatchReplay([jobs()[0],null],items,"project-1").matches,false);
 assert.equal(inspectBatchReplay(jobs(),"different-project").matches,false);
 const changed=items.map(item=>({...item}));
 changed[1].scale=2;
 assert.equal(inspectBatchReplay(jobs(),changed,"project-1").matches,false);
 assert.deepEqual(inspectBatchReplay([null,null],items,"project-1"),{exists:false,matches:false,batchId:null});
});
