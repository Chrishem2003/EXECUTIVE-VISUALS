import assert from "node:assert/strict";
import test from "node:test";
import {isRetryableB2PartError,retryB2PartUpload} from "../../src/core/b2-part-retry.ts";

const failure=(status,code="PROVIDER_ERROR")=>Object.assign(new Error("upload failed"),{status,code});

test("retries transient provider responses and browser transport failures only",()=>{
 for(const status of [408,425,429,500,502,503,599])assert.equal(isRetryableB2PartError(failure(status)),true,String(status));
 for(const status of [400,401,403,404,409,422])assert.equal(isRetryableB2PartError(failure(status)),false,String(status));
 assert.equal(isRetryableB2PartError(Object.assign(new Error("offline"),{code:"B2_PART_NETWORK_ERROR"})),true);
 assert.equal(isRetryableB2PartError(Object.assign(new Error("timeout"),{code:"B2_PART_TIMEOUT"})),true);
 assert.equal(isRetryableB2PartError(new TypeError("Failed to fetch")),true);
 assert.equal(isRetryableB2PartError(new Error("cancelled")),false);
});

test("requests a new upload attempt after bounded exponential backoff",async()=>{
 let attempts=0;
 const delays=[];
 const signedUrls=[];
 const result=await retryB2PartUpload({
  upload:async()=>{attempts++;signedUrls.push("signed-"+attempts);if(attempts<3)throw failure(503);return{etag:"final-etag"};},
  wait:async ms=>{delays.push(ms);}
 });
 assert.deepEqual(result,{etag:"final-etag"});
 assert.equal(attempts,3);
 assert.deepEqual(signedUrls,["signed-1","signed-2","signed-3"]);
 assert.deepEqual(delays,[350,700]);
});

test("does not retry validation, authorization, cancellation or conflict errors",async()=>{
 for(const error of [failure(400),failure(401),failure(403),failure(409),new Error("cancelled")]){
  let attempts=0,waits=0;
  await assert.rejects(()=>retryB2PartUpload({upload:async()=>{attempts++;throw error;},wait:async()=>{waits++;}}),candidate=>candidate===error);
  assert.equal(attempts,1);
  assert.equal(waits,0);
 }
});

test("caps retry attempts and propagates the final provider error",async()=>{
 let attempts=0;
 const error=failure(503);
 await assert.rejects(()=>retryB2PartUpload({maxAttempts:99,upload:async()=>{attempts++;throw error;},wait:async()=>{}}),candidate=>candidate===error);
 assert.equal(attempts,5);
});

test("aborted requests are never retried",async()=>{
 const error=Object.assign(new Error("Upload cancelled."),{name:"AbortError"});
 let attempts=0;
 await assert.rejects(()=>retryB2PartUpload({upload:async()=>{attempts++;throw error;},wait:async()=>{}}),candidate=>candidate===error);
 assert.equal(attempts,1);
});
