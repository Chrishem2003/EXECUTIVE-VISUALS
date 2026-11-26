import test from "node:test";
import assert from "node:assert/strict";
import {runOperationalMonitor} from "../../scripts/monitor-executive-visuals.mjs";

const env={
 OPS_ALERT_WEBHOOK_URL:"https://alerts.example.test/hooks/opaque",
 EXECUTIVE_VISUALS_HEALTH_URL:"https://staging.example.test/api/health"
};
const now=()=>new Date("2026-11-26T09:30:00.000Z");

test("rejects non-HTTPS or credential-bearing webhook endpoints before network access",async()=>{
 let calls=0;
 await assert.rejects(()=>runOperationalMonitor({env:{...env,OPS_ALERT_WEBHOOK_URL:"http://alerts.example.test/hook"},fetchImpl:async()=>{calls++;}}),{code:"MONITOR_WEBHOOK_CONFIG_INVALID"});
 await assert.rejects(()=>runOperationalMonitor({env:{...env,OPS_ALERT_WEBHOOK_URL:"https://user:pass@alerts.example.test/hook"},fetchImpl:async()=>{calls++;}}),{code:"MONITOR_WEBHOOK_CONFIG_INVALID"});
 assert.equal(calls,0);
});

test("rejects invalid health URLs before network access",async()=>{
 let calls=0;
 await assert.rejects(()=>runOperationalMonitor({env:{...env,EXECUTIVE_VISUALS_HEALTH_URL:"http://staging.example.test/health"},fetchImpl:async()=>{calls++;}}),{code:"MONITOR_HEALTH_CONFIG_INVALID"});
 assert.equal(calls,0);
});

test("manual alert delivery sends a bounded synthetic info event and requires HTTP 2xx",async()=>{
 let request;
 const result=await runOperationalMonitor({env,fetchImpl:async(url,options)=>{
  request={url,options};return new Response(null,{status:204});
 },testMode:true,now});
 assert.equal(result.result,"alert_delivery_confirmed");
 assert.equal(result.httpStatus,204);
 assert.equal(request.options.redirect,"error");
 const payload=JSON.parse(request.options.body);
 assert.equal(payload.event,"monitoring.test");
 assert.equal(payload.severity,"info");
 assert.equal(payload.timestamp,"2026-11-26T09:30:00.000Z");
 assert.equal(result.credentialValuesExposed,false);
});

test("only explicitly healthy JSON responses are reported healthy",async()=>{
 let calls=0;
 const result=await runOperationalMonitor({env,fetchImpl:async url=>{
  calls++;
  if(url===env.EXECUTIVE_VISUALS_HEALTH_URL)return Response.json({ok:true,status:"healthy",checks:[{name:"database",status:"ok"}]});
  throw new Error("healthy probes must not notify");
 },now});
 assert.equal(result.result,"healthy");
 assert.equal(calls,1);
});

test("ambiguous or unhealthy health responses generate a critical alert",async()=>{
 const calls=[];
 const result=await runOperationalMonitor({env,fetchImpl:async(url,options)=>{
  calls.push({url,options});
  if(options.method==="GET")return Response.json({status:"degraded",checks:[{name:"worker",status:"failed"}]});
  return new Response(null,{status:200});
 },now});
 assert.equal(result.result,"health_failure_alerted");
 assert.equal(result.webhookStatus,200);
 const alert=JSON.parse(calls[1].options.body);
 assert.equal(alert.severity,"critical");
 assert.equal(alert.event,"health.check.failed");
 assert.deepEqual(alert.details.failedChecks,["worker"]);
});

test("invalid JSON and oversized health responses trigger alerts rather than false healthy status",async()=>{
 const invalid=await runOperationalMonitor({env,fetchImpl:async(url,options)=>{
  return options.method==="GET"?new Response("not-json",{status:200}):new Response(null,{status:204});
 },now});
 assert.equal(invalid.result,"health_failure_alerted");
 assert.equal(invalid.reportedStatus,"invalid_json");
 const large=await runOperationalMonitor({env,fetchImpl:async(url,options)=>{
  if(options.method==="GET"){
   const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(64*1024+1));controller.close();}});
   return new Response(body,{status:200});
  }
  return new Response(null,{status:204});
 },now});
 assert.equal(large.result,"health_failure_alerted");
 assert.equal(large.reportedStatus,"probe_failed");
 assert.equal(large.errorCode,"MONITOR_RESPONSE_TOO_LARGE");
});

test("webhook rejection never exposes the webhook response body",async()=>{
 await assert.rejects(()=>runOperationalMonitor({env,fetchImpl:async()=>new Response("sensitive provider response body",{status:503}),testMode:true,now}),
  error=>error.code==="MONITOR_WEBHOOK_HTTP_503"&&!error.message.includes("sensitive provider response body"));
});

test("health probe network failures are alerted with sanitized error codes",async()=>{
 const result=await runOperationalMonitor({env,fetchImpl:async(url,options)=>{
  if(options.method==="GET")throw Object.assign(new Error("private network detail"),{code:"ECONNRESET"});
  return new Response(null,{status:204});
 },now});
 assert.equal(result.result,"health_failure_alerted");
 assert.equal(result.errorCode,"ECONNRESET");
 assert.equal(JSON.stringify(result).includes("private network detail"),false);
});
