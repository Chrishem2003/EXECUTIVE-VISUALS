/**
 * Bounded maintenance worker for abandoned B2 multipart uploads.
 * It never deletes completed objects; it only aborts provider multipart sessions.
 */
export function createB2MultipartCleanupWorker({
 store,storage,limit=25,cleanupLeaseMs=5*60*1000,completionLeaseMs=5*60*1000,
 onEvent=()=>{},clock=()=>new Date()
}={}){
 if(!store||typeof store.claimExpiredSessions!=="function"||typeof store.markAborted!=="function")throw new Error("B2 multipart cleanup requires the durable session ledger.");
 if(!storage||typeof storage.abortMultipartUpload!=="function")throw new Error("B2 multipart cleanup requires the B2 abort adapter.");
 if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error("B2 multipart cleanup batch limit is invalid.");
 if(!Number.isInteger(cleanupLeaseMs)||cleanupLeaseMs<30_000||cleanupLeaseMs>60*60*1000)throw new Error("B2 multipart cleanup lease is invalid.");
 if(!Number.isInteger(completionLeaseMs)||completionLeaseMs<30_000||completionLeaseMs>60*60*1000)throw new Error("B2 multipart completion lease is invalid.");
 if(typeof clock!=="function"||typeof onEvent!=="function")throw new Error("B2 multipart cleanup callbacks are invalid.");

 async function runCycle(){
  const claimed=await store.claimExpiredSessions({limit,cleanupLeaseMs,completionLeaseMs});
  const results=[];
  for(const session of claimed){
   const result={sessionId:session.id,status:"pending"};
   try{
    try{
     await storage.abortMultipartUpload(session.objectPath,session.uploadId);
     result.providerAbort="aborted";
    }catch(error){
     // An earlier attempt may have reached B2 before the worker crashed.
     // A 404 means there is no unfinished provider upload left to retain.
     if(error?.status===404||error?.code==="B2_STORAGE_HTTP_404")result.providerAbort="already_absent";
     else throw error;
    }
    const finalized=await store.markAborted({ownerId:session.ownerId,sessionId:session.id,expired:true});
    if(!finalized)throw Object.assign(new Error("Expired multipart cleanup claim could not be finalized."),{code:"B2_MULTIPART_CLEANUP_STATE_CONFLICT"});
    result.status="expired";
   }catch(error){
    result.status="retry_pending";
    result.errorCode=error?.code||"B2_MULTIPART_CLEANUP_FAILED";
    result.message=String(error?.message||"Multipart cleanup failed.").slice(0,240);
   }
   results.push(result);
   onEvent({type:"b2.multipart.cleanup",...result});
  }
  return {
   scanned:claimed.length,
   expired:results.filter(item=>item.status==="expired").length,
   retryPending:results.filter(item=>item.status==="retry_pending").length,
   results,
   at:clock().toISOString()
  };
 }
 return Object.freeze({runCycle});
}
