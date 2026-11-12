import {createHash} from "node:crypto";

export function createBatchIdempotencyKeys(value,count){
 const key=String(value??"");
 if(key.length>180)throw new Error("Batch idempotency key must not exceed 180 characters.");
 if(!key)return [];
 if(!Number.isSafeInteger(count)||count<1||count>100)throw new Error("Batch idempotency count must be between 1 and 100.");
 const digest=createHash("sha256").update(key).digest("hex");
 return Array.from({length:count},(_,index)=>"batch:"+digest+":"+index);
}

export function inspectBatchReplay(existingJobs,items,projectId){
 if(!Array.isArray(existingJobs)||!Array.isArray(items)||existingJobs.length!==items.length)throw new Error("Batch replay inspection requires aligned jobs and items.");
 const exists=existingJobs.some(Boolean);
 if(!exists)return {exists:false,matches:false,batchId:null};
 if(existingJobs.some(job=>!job))return {exists:true,matches:false,batchId:null};
 let first;
 try{first=JSON.parse(existingJobs[0].input_json||"{}");}catch{return {exists:true,matches:false,batchId:null};}
 const batchId=typeof first.batchId==="string"&&first.batchId?first.batchId:null;
 if(!batchId)return {exists:true,matches:false,batchId:null};
 const matches=existingJobs.every((job,index)=>{
  let input;
  try{input=JSON.parse(job.input_json||"{}");}catch{return false;}
  const item=items[index];
  return job.job_type==="media.ai-upscale"&&job.project_id===projectId&&
   input.batchId===batchId&&input.batchIndex===index&&input.batchTotal===items.length&&
   input.sourceAssetId===item.sourceAssetId&&input.model===item.model&&
   input.scale===item.scale&&input.tile===item.tile&&input.format===item.format;
 });
 return {exists:true,matches,batchId};
}
