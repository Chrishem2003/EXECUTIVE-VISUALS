import { evaluateCloudStagingAcceptance } from "../server/cloud-staging-acceptance.mjs";

const baseUrl=String(process.env.EXECUTIVE_VISUALS_CLOUD_STAGING_URL||"").trim();
if(!baseUrl){
 console.error("Set EXECUTIVE_VISUALS_CLOUD_STAGING_URL to https://executive-visuals-cloud-staging.onrender.com");
 process.exitCode=2;
}else{
 try{
  const target=new URL(baseUrl);
  if(target.protocol!=="https:"||target.hostname.toLowerCase()!=="executive-visuals-cloud-staging.onrender.com"||target.port!==""||
     target.username||target.password||target.search||target.hash||target.pathname!=="/"){
   throw new Error("Refusing a non-staging or non-HTTPS target. No request was sent.");
  }
  async function read(path){
   const response=await fetch(new URL(path,target),{method:"GET",redirect:"error",signal:AbortSignal.timeout(12000),headers:{accept:"application/json"}});
   let body=null;
   try{body=await response.json();}catch{}
   return{httpOk:response.ok,body};
  }
  const [health,readiness]=await Promise.all([read("/api/health"),read("/api/ready")]);
  const result=evaluateCloudStagingAcceptance({
   baseUrl:target.origin,
   health:health.httpOk?health.body:{status:"http_error"},
   readiness:readiness.body
  });
  console.log(JSON.stringify({
   target:result.target,status:result.status,passed:result.passed,
   endpoints:{health:health.httpOk?"http_ok":"http_error",readiness:readiness.httpOk?"http_ok":"http_blocked"},
   checks:result.checks
  },null,2));
  if(!result.passed)process.exitCode=1;
 }catch(error){
  console.error("Cloud staging acceptance could not be completed:",error instanceof Error?error.message:"unknown error");
  process.exitCode=1;
 }
}
