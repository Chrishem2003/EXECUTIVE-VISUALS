import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {mkdtemp,mkdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

const now=new Date();
const pricing=[{
 provider:"runway",model:"kling_4",currency:"USD",
 sourceUrl:"https://dev.runway.com/pricing",
 observedAt:new Date(now.getTime()-3600000).toISOString(),
 expiresAt:new Date(now.getTime()+86400000).toISOString(),
 ratesPerSecond:{"1080p":0.235},
 minimumCharge:0,audioSurchargePerSecond:0,referenceImageFee:0,billingIncrementSeconds:1
}];
const policy={
 CUSTOMER_CREDIT_VALUE_MINOR:"1",
 CUSTOMER_CREDIT_MINOR_UNITS_PER_MAJOR:"100",
 CUSTOMER_CREDIT_TARGET_MARGIN_BPS:"6000",
 CUSTOMER_CREDIT_PAYMENT_FEE_BPS:"300",
 CUSTOMER_CREDIT_RETRY_RESERVE_BPS:"500",
 CUSTOMER_CREDIT_INFRA_RESERVE_BPS:"300",
 CUSTOMER_CREDIT_FIXED_PAYMENT_FEE_MINOR:"30",
 CUSTOMER_CREDIT_PRICING_VERSION:"test-v1"
};
const port=await new Promise(resolve=>{const s=createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const dataDir=await mkdtemp(join(tmpdir(),"ev-commercial-quote-"));
const webDir=join(dataDir,"web");
await mkdir(webDir,{recursive:true});
await writeFile(join(webDir,"index.html"),"<!doctype html><html><body>test</body></html>");
const child=spawn(process.execPath,["server/index.mjs"],{
 cwd:process.cwd(),
 env:{...process.env,NODE_ENV:"development",AUTH_MODE:"local",AUTH_RATE_LIMIT:"1000",
  API_HOST:"127.0.0.1",API_PORT:String(port),DATA_DIR:dataDir,MEDIA_ROOT:join(dataDir,"media"),
  WEB_ROOT:webDir,DISABLE_WORKER:"true",VIDEO_MODEL_PRICING_JSON:JSON.stringify(pricing),...policy},
 stdio:["ignore","pipe","pipe"]
});
let stderr="";
child.stderr.on("data",chunk=>stderr+=chunk.toString());
const base="http://127.0.0.1:"+port;
async function waitForApi(){
 for(let i=0;i<100;i++){
  if(child.exitCode!==null)throw new Error("API exited early: "+stderr);
  try{const r=await fetch(base+"/api/health");if(r.ok)return;}catch{}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 throw new Error("API did not start: "+stderr);
}
async function register(email){
 const r=await fetch(base+"/api/auth/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email,password:"local-test-password-123"})});
 assert.equal(r.status,201,await r.text());
 return r.headers.get("set-cookie").split(";")[0];
}
async function post(path,body,cookie){
 return fetch(base+path,{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify(body)});
}
await waitForApi();

test("single-generation estimate returns provider cost and margin-protected customer credits without starting a job",async()=>{
 const cookie=await register("commercial-quote-owner@example.test");
 const response=await post("/api/video-cost-estimate",{
  provider:"runway",model:"kling_4",durationSeconds:10,resolution:"1080p",audioMode:"none",referenceImageCount:0
 },cookie);
 assert.equal(response.status,200,await response.text());
 const body=await response.json();
 assert.equal(body.available,true);
 assert.equal(body.amount,2.35);
 assert.equal(body.customerCreditQuote.available,true);
 assert.equal(body.customerCreditQuote.billable,false);
 assert.equal(body.customerCreditQuote.authorizationRequired,true);
 assert.ok(body.customerCreditQuote.customerCredits>255);
 assert.ok(body.customerCreditQuote.estimatedMarginBps>=6000);
 assert.equal(body.customerCreditQuote.pricingVersion,"test-v1");
 assert.equal("jobId" in body,false);
});

test("multi-shot production quote aggregates provider costs and returns a single margin-aware credit preview",async()=>{
 const cookie=await register("commercial-production-owner@example.test");
 const response=await post("/api/video-production-quote",{shots:[
  {id:"opening",provider:"runway",model:"kling_4",durationSeconds:5,resolution:"1080p",audioMode:"none",referenceImageCount:0},
  {id:"close",provider:"runway",model:"kling_4",durationSeconds:5,resolution:"1080p",audioMode:"none",referenceImageCount:0}
 ]},cookie);
 assert.equal(response.status,200,await response.text());
 const body=await response.json();
 assert.equal(body.available,true);
 assert.equal(body.amount,2.35);
 assert.equal(body.shotCount,2);
 assert.equal(body.customerCreditQuote.available,true);
 assert.equal(body.customerCreditQuote.billable,false);
 assert.ok(body.customerCreditQuote.customerCredits>255);
});

test("unknown provider rates never receive a guessed customer-credit quote",async()=>{
 const cookie=await register("commercial-unpriced-owner@example.test");
 const response=await post("/api/video-cost-estimate",{
  provider:"runway",model:"not-in-catalog",durationSeconds:10,resolution:"1080p",audioMode:"none"
 },cookie);
 assert.equal(response.status,200);
 const body=await response.json();
 assert.equal(body.available,false);
 assert.equal(body.customerCreditQuote.available,false);
 assert.equal(body.customerCreditQuote.billable,false);
});

test.after(async()=>{
 child.kill("SIGTERM");
 await new Promise(resolve=>child.once("exit",resolve));
 await rm(dataDir,{recursive:true,force:true});
});
