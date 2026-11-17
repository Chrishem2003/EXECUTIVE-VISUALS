const STAGING_HOST="executive-visuals-cloud-staging.onrender.com";

function check(id,passed,reason){
 return Object.freeze({id,status:passed?"passed":"blocked",...(passed?{}:{reason})});
}

/**
 * Evaluate the read-only hosted staging gate from public health endpoints.
 * This proves configuration/readiness only; it never submits a job or calls a provider.
 */
export function evaluateCloudStagingAcceptance({baseUrl,health,readiness}={}){
 let url=null;
 try{url=new URL(String(baseUrl||""));}catch{}
 const targetValid=Boolean(url&&url.protocol==="https:"&&url.hostname.toLowerCase()===STAGING_HOST&&
  !url.username&&!url.password&&!url.search&&!url.hash&&(url.pathname==="/"||url.pathname===""));
 const worker=health?.cloudVideoWorker||{};
 const media=health?.cloudMedia||{};
 const checks=[
  check("staging-target",targetValid,"Target must be the dedicated HTTPS cloud-staging Render service; production and arbitrary hosts are refused."),
  check("health-endpoint",health?.status==="ok","The staging health endpoint did not report status=ok."),
  check("supabase-auth",health?.authMode==="supabase"&&health?.authSession?.configurationReady===true,
   "Supabase authentication and server-managed session configuration must be ready."),
  check("supabase-service-credentials",worker.supabaseCredentialsConfigured===true,
   "The hosted runtime does not report its server-side Supabase credentials as configured."),
  check("private-cloud-media",media.enabled===true&&media.ready===true&&media.storage==="private"&&media.provider==="supabase",
   "The isolated Supabase private media backend has not passed its startup readiness check."),
  check("cloud-media-jobs-api",health?.cloudMediaJobsApi?.enabled===true,
   "The authenticated cloud media jobs API is not enabled."),
  check("cloud-worker-configured",worker.enabled===true&&worker.outputHostAllowlistConfigured===true,
   "The cloud worker gates or bounded output-host allowlist are not configured."),
  check("paid-provider-execution-disabled",worker.remoteExecutionGates!==true,
   "Remote provider execution must remain disabled during no-cost staging acceptance."),
  check("application-readiness",readiness?.ready===true&&readiness?.status==="ready",
   "The application readiness endpoint reports one or more blocked deployment checks.")
 ];
 const passed=checks.every(item=>item.status==="passed");
 return Object.freeze({target:targetValid?url.origin:"rejected",passed,status:passed?"ready":"blocked",checks});
}

