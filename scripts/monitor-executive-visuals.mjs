import {pathToFileURL} from "node:url";

const MAX_HEALTH_BYTES=64*1024;
const MAX_WEBHOOK_RESPONSE_BYTES=2048;
const HTTPS_URL=value=>{
 try{
  const url=new URL(value);
  return url.protocol==="https:"&&!url.username&&!url.password&&!url.hash?url:null;
 }catch{return null;}
};

async function limitedText(response,limit){
 const reader=response.body?.getReader?.();
 if(!reader){
  const text=await response.text();
  if(Buffer.byteLength(text)>limit)throw Object.assign(new Error("Monitoring response exceeded its size limit."),{code:"MONITOR_RESPONSE_TOO_LARGE"});
  return text;
 }
 const chunks=[];let size=0;
 try{
  while(true){
   const {done,value}=await reader.read();
   if(done)break;
   size+=value.byteLength;
   if(size>limit){
    await reader.cancel().catch(()=>{});
    throw Object.assign(new Error("Monitoring response exceeded its size limit."),{code:"MONITOR_RESPONSE_TOO_LARGE"});
   }
   chunks.push(Buffer.from(value));
  }
 }finally{reader.releaseLock?.();}
 return Buffer.concat(chunks).toString("utf8");
}

function configuration(env,testMode){
 const webhook=HTTPS_URL(String(env.OPS_ALERT_WEBHOOK_URL||"").trim());
 if(!webhook)throw Object.assign(new Error("OPS_ALERT_WEBHOOK_URL must be a valid HTTPS webhook URL."),{code:"MONITOR_WEBHOOK_CONFIG_INVALID"});
 if(testMode)return{webhook};
 const health=HTTPS_URL(String(env.EXECUTIVE_VISUALS_HEALTH_URL||"").trim());
 if(!health)throw Object.assign(new Error("EXECUTIVE_VISUALS_HEALTH_URL must be a valid HTTPS health endpoint."),{code:"MONITOR_HEALTH_CONFIG_INVALID"});
 return{webhook,health};
}

export async function runOperationalMonitor({
 env=process.env,fetchImpl=globalThis.fetch,testMode=process.argv.includes("--test-alert"),
 now=()=>new Date()
}={}){
 if(typeof fetchImpl!=="function")throw new Error("A monitoring fetch implementation is required.");
 const {webhook,health}=configuration(env,testMode);
 const notify=async payload=>{
  let response;
  try{
   response=await fetchImpl(webhook.toString(),{
    method:"POST",headers:{"content-type":"application/json",accept:"application/json"},
    body:JSON.stringify(payload),signal:AbortSignal.timeout(15000),redirect:"error"
   });
   await limitedText(response,MAX_WEBHOOK_RESPONSE_BYTES);
  }catch(error){
   throw Object.assign(new Error("Operations alert webhook delivery failed."),{code:error?.code||"MONITOR_WEBHOOK_DELIVERY_FAILED"});
  }
  if(!response.ok)throw Object.assign(new Error("Operations alert webhook rejected delivery (HTTP "+response.status+")."),{
   code:"MONITOR_WEBHOOK_HTTP_"+response.status,status:response.status
  });
  return response.status;
 };
 const timestamp=now().toISOString();
 if(testMode){
  const status=await notify({
   text:"Executive Visuals monitoring test: alert delivery is configured.",
   source:"executive-visuals",event:"monitoring.test",severity:"info",timestamp
  });
  return{result:"alert_delivery_confirmed",httpStatus:status,event:"monitoring.test",credentialValuesExposed:false};
 }

 let failure=null;
 try{
  const response=await fetchImpl(health.toString(),{
   method:"GET",headers:{accept:"application/json"},signal:AbortSignal.timeout(15000),redirect:"error"
  });
  if(!response.ok){
   failure={httpStatus:response.status,reportedStatus:"http_error",failedChecks:[]};
  }else{
   const raw=await limitedText(response,MAX_HEALTH_BYTES);
   let data=null;try{data=JSON.parse(raw);}catch{}
   if(!data||typeof data!=="object"||Array.isArray(data)){
    failure={httpStatus:response.status,reportedStatus:"invalid_json",failedChecks:[]};
   }else{
    const statusValue=String(data.status||data.health?.status||"").toLowerCase();
    const failedChecks=Array.isArray(data.checks)
     ?data.checks.filter(item=>["failed","error","unhealthy","blocked"].includes(String(item?.status||"").toLowerCase()))
       .map(item=>String(item.name||item.key||"unknown").slice(0,80))
     :[];
    const explicitlyHealthy=data.ok===true||["ok","healthy","ready"].includes(statusValue);
    if(!explicitlyHealthy||data.ok===false||["error","unhealthy","failed","down","degraded"].includes(statusValue)||failedChecks.length){
     failure={httpStatus:response.status,reportedStatus:statusValue||"health_not_explicitly_healthy",failedChecks};
    }
   }
  }
 }catch(error){
  failure={httpStatus:null,reportedStatus:"probe_failed",failedChecks:[],
   errorCode:String(error?.code||error?.name||"NETWORK_ERROR").replace(/[^A-Z0-9_]/gi,"_").slice(0,80)};
 }
 if(failure){
  const delivered=await notify({
   text:"Executive Visuals health check failed: "+health.host,
   source:"executive-visuals",event:"health.check.failed",severity:"critical",timestamp,details:failure
  });
  return{result:"health_failure_alerted",webhookStatus:delivered,host:health.host,...failure,credentialValuesExposed:false};
 }
 return{result:"healthy",checkedAt:timestamp,host:health.host,credentialValuesExposed:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 runOperationalMonitor().then(report=>{
  console.log(JSON.stringify(report));
  if(report.result==="health_failure_alerted")process.exitCode=1;
 }).catch(error=>{
  console.log(JSON.stringify({result:"failed",code:error?.code||"MONITORING_FAILED",credentialValuesExposed:false}));
  process.exitCode=1;
 });
}
