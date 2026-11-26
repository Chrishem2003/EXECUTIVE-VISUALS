const FAMILY=new Set(["media","timeline","video","publication_cleanup","gemini_files_cleanup","gemini_files_recovery","b2_multipart_cleanup","storage_maintenance"]);
const STATUS=new Set(["starting","healthy","degraded","stopping","stopped"]);
const CODE=/^[A-Z0-9_]{1,80}$/;

/** Service-role-only adapter for process-level worker liveness. */
export function createCloudWorkerHeartbeat({rpc,workerId,workerFamilies,enabled=true}={}){
 if(typeof rpc!=="function")throw new Error("Worker heartbeat requires a database RPC.");
 if(!enabled)return Object.freeze({record:async()=>({recorded:false,reason:"worker_heartbeat_disabled"})});
 if(typeof workerId!=="string"||workerId.length<1||workerId.length>128)throw new Error("Worker heartbeat ID is invalid.");
 if(!Array.isArray(workerFamilies)||workerFamilies.length<1||workerFamilies.length>8||
    workerFamilies.some(x=>!FAMILY.has(x))||new Set(workerFamilies).size!==workerFamilies.length)
  throw new Error("Worker heartbeat families are invalid.");
 async function record({status="healthy",lastCycleAt=null,lastErrorCode=null}={}){
  if(!STATUS.has(status))throw new Error("Worker heartbeat status is invalid.");
  if(lastCycleAt!==null&&(typeof lastCycleAt!=="string"||!Number.isFinite(Date.parse(lastCycleAt))))
   throw new Error("Worker heartbeat cycle timestamp is invalid.");
  if(lastErrorCode!==null&&(typeof lastErrorCode!=="string"||!CODE.test(lastErrorCode)))
   throw new Error("Worker heartbeat error code is invalid.");
  const result=await rpc("record_cloud_worker_heartbeat",{
   p_worker_id:workerId,p_worker_families:workerFamilies,p_status:status,
   p_last_cycle_at:lastCycleAt,p_last_error_code:lastErrorCode
  });
  return {recorded:true,result:result?.data??result};
 }
 return Object.freeze({record});
}
