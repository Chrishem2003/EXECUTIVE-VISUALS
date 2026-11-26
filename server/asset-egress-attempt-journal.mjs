import {randomUUID} from "node:crypto";
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Server-only adapter for the durable private-download attempt journal. */
export function createAssetEgressAttemptJournal({rpc,actorId,enabled=false}={}){
 if(typeof rpc!=="function")throw new Error("Egress attempt journal requires a database RPC.");
 if(enabled&&!UUID.test(String(actorId||"")))throw new Error("Egress attempt journal requires a financial actor.");
 async function call(name,args){
  const result=await rpc(name,args);
  return result?.data??result;
 }
 return Object.freeze({
  async begin({asset,transferId=randomUUID(),initiatedBy}={}){
   if(!enabled)return {recorded:false,reason:"egress_attempt_journal_disabled"};
   if(!asset||!UUID.test(String(asset.id||""))||!UUID.test(String(asset.owner_id||asset.ownerId||"")))
    throw new Error("Egress attempt asset attribution is invalid.");
   if(initiatedBy&&initiatedBy!==actorId)throw new Error("Egress attempt actor mismatch.");
   if(!UUID.test(String(transferId)))throw new Error("Egress transfer ID is invalid.");
   const result=await call("begin_asset_egress_transfer_attempt",{
    p_actor_id:actorId,p_transfer_id:transferId,p_asset_id:asset.id,
    p_owner_id:asset.owner_id||asset.ownerId,p_project_id:asset.project_id||asset.projectId||null
   });
   return {recorded:true,transferId,result};
  },
  async finish({transferId,status,transferredBytes,upstreamStatus,measurementId=null,errorCode=null}={}){
   if(!enabled)return {recorded:false,reason:"egress_attempt_journal_disabled"};
   if(!UUID.test(String(transferId))||!["completed","partial","measurement_failed"].includes(status)||
      !Number.isSafeInteger(transferredBytes)||transferredBytes<0||transferredBytes>2*1024*1024*1024)
    throw new Error("Egress attempt outcome is invalid.");
   const result=await call("finish_asset_egress_transfer_attempt",{
    p_actor_id:actorId,p_transfer_id:transferId,p_status:status,p_transferred_bytes:transferredBytes,
    p_upstream_status:upstreamStatus??null,p_measurement_id:measurementId,p_error_code:errorCode
   });
   return {recorded:true,result};
  }
 });
}
