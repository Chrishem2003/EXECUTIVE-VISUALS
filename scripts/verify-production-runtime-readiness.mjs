import {pathToFileURL} from "node:url";

export function assessRuntimeReadiness(data){
 const checks=[
  {key:"postgres_database",passed:data?.database==="postgres",observed:String(data?.database??"missing")},
  {key:"durable_storage",passed:data?.storage!=="local-disk"&&data?.persistence?.durableAcrossDeploys===true,observed:String(data?.storage??"missing")},
  {key:"private_cloud_media",passed:data?.cloudMedia?.enabled===true&&data?.cloudMedia?.ready===true,observed:data?.cloudMedia?.ready===true?"ready":String(data?.cloudMedia?.storage??"disabled")},
  {key:"supabase_auth_session",passed:data?.authMode==="supabase"&&data?.authSession?.configurationReady===true,observed:String(data?.authMode??"missing")},
  {key:"dedicated_worker",passed:data?.cloudVideoWorker?.enabled===true&&data?.cloudVideoWorker?.runtimeMode==="separate-process",observed:String(data?.cloudVideoWorker?.enabled===true?data.cloudVideoWorker.runtimeMode??"enabled":"disabled")},
  {key:"provider_execution_gate",passed:data?.cloudVideoWorker?.remoteExecutionGates===true&&data?.cloudVideoWorker?.providerCredentialConfigured===true&&data?.cloudVideoWorker?.outputHostAllowlistConfigured===true,observed:data?.cloudVideoWorker?.remoteExecutionGates===true?"configured":"disabled"},
  {key:"payment_provider_configuration",passed:data?.billing?.enabled===true&&data?.billing?.providerKeyConfigured===true,observed:data?.billing?.enabled===true?"enabled":"disabled"}
 ];
 const blockers=checks.filter(x=>!x.passed).map(x=>x.key);
 return {runtimeReady:blockers.length===0,checks,blockers,manualEvidenceRequired:["private_storage_roundtrip_and_tenant_isolation","worker_process_restart_and_queue_recovery","encrypted_backup_and_isolated_restore","real_alert_delivery","provider_sandbox_checkout_webhook_and_reconciliation","production_database_cutover_and_rollback"]};
}

async function main(){
 const url=process.env.EXECUTIVE_VISUALS_HEALTH_URL||"https://executive-visuals.onrender.com/api/health";
 const response=await fetch(url,{headers:{accept:"application/json"},redirect:"error",signal:AbortSignal.timeout(20000)});
 const raw=await response.text();let data;
 try{data=JSON.parse(raw);}catch{throw new Error("Health endpoint returned invalid JSON (HTTP "+response.status+").");}
 if(!response.ok)throw new Error("Health endpoint returned HTTP "+response.status+".");
 if(!data||typeof data!=="object"||Array.isArray(data)||typeof data.status!=="string")throw new Error("Health endpoint payload shape is invalid.");
 const result=assessRuntimeReadiness(data);
 console.log(JSON.stringify({endpoint:new URL(url).host,httpStatus:response.status,reportedStatus:data.status,...result},null,2));
 if(!result.runtimeReady)process.exitCode=2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{process.stderr.write(String(error.message||error)+"\n");process.exitCode=1;});
