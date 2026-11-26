import assert from "node:assert/strict";
const healthUrl=process.env.EXECUTIVE_VISUALS_HEALTH_URL||"";
const webhook=process.env.OPS_ALERT_WEBHOOK_URL||"";
const testMode=process.argv.includes("--test-alert");
const requirePostgres=process.env.EXECUTIVE_VISUALS_REQUIRE_POSTGRES==="true";
const requireCloudMedia=process.env.EXECUTIVE_VISUALS_REQUIRE_CLOUD_MEDIA==="true";
if(!webhook)throw new Error("OPS_ALERT_WEBHOOK_URL is required for alert delivery.");
if(!testMode&&!healthUrl)throw new Error("EXECUTIVE_VISUALS_HEALTH_URL is required for monitoring.");
async function notify(payload){
 const response=await fetch(webhook,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
 const body=(await response.text()).slice(0,300);
 if(!response.ok)throw new Error("Operations alert webhook rejected delivery with HTTP "+response.status+": "+body);
 return response.status;
}
if(testMode){
 const status=await notify({text:"Executive Visuals monitoring test: alert delivery is configured.",source:"executive-visuals",event:"monitoring.test",severity:"info",timestamp:new Date().toISOString()});
 console.log(JSON.stringify({result:"alert_delivery_confirmed",httpStatus:status,event:"monitoring.test"}));
}else{
 let failure=null;
 try{
  const response=await fetch(healthUrl,{headers:{accept:"application/json"},signal:AbortSignal.timeout(15000),redirect:"error"});
  const raw=await response.text();
  let data=null;try{data=JSON.parse(raw);}catch{}
  const statusValue=String(data?.status||data?.health?.status||"").toLowerCase();
  const validShape=!!data&&typeof data==="object"&&!Array.isArray(data)&&(typeof data.status==="string"||typeof data.ok==="boolean"||typeof data.health?.status==="string"||Array.isArray(data.checks));
  const failedChecks=Array.isArray(data?.checks)?data.checks.filter(x=>["failed","error","unhealthy","blocked"].includes(String(x?.status||"").toLowerCase())).map(x=>String(x.name||x.key||"unknown").slice(0,80)): [];
  if(requirePostgres&&data?.database!=="postgres")failedChecks.push("database.persistence");
  if(requireCloudMedia&&!(data?.cloudMedia?.enabled===true&&data?.cloudMedia?.ready===true))failedChecks.push("cloudMedia.readiness");
  if(!response.ok||!validShape||data?.ok===false||["error","unhealthy","failed","down"].includes(statusValue)||failedChecks.length){
   failure={httpStatus:response.status,reportedStatus:statusValue||"unspecified",failedChecks,readinessRequirements:{postgres:requirePostgres,cloudMedia:requireCloudMedia}};
  }else if(!data){
   failure={httpStatus:response.status,reportedStatus:"invalid_health_payload",failedChecks:[],readinessRequirements:{postgres:requirePostgres,cloudMedia:requireCloudMedia}};
  }
 }catch(error){failure={httpStatus:null,reportedStatus:"probe_failed",failedChecks:[],errorCode:String(error?.name||"NETWORK_ERROR").slice(0,80)};}
 if(failure){
  let host="configured-health-endpoint";try{host=new URL(healthUrl).host;}catch{}
  const delivered=await notify({text:"Executive Visuals health check failed: "+host,source:"executive-visuals",event:"health.check.failed",severity:"critical",timestamp:new Date().toISOString(),details:failure});
  console.error(JSON.stringify({result:"health_failure_alerted",webhookStatus:delivered,host,...failure}));
  process.exitCode=1;
 }else{
  console.log(JSON.stringify({result:"healthy",checkedAt:new Date().toISOString()}));
 }
}
