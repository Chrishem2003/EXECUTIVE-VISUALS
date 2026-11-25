import { createHash } from "node:crypto";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=value=>createHash("sha256").update(String(value)).digest("hex");

/**
 * Server-side adapter for the atomic asset event/checkpoint RPC.
 * It deliberately accepts an asset measurement, never a generation job.
 */
export function createAssetResourceEventRecorder({rpc,actorId,enabled=false}={}) {
  if(typeof rpc!=="function")throw new Error("Asset resource recorder requires a database RPC function.");
  async function record({asset,measurement}={}) {
    if(!enabled)return {recorded:false,reason:"resource_cost_metering_disabled"};
    if(!UUID.test(String(actorId||"")))return {recorded:false,reason:"financial_system_actor_not_configured"};
    if(!asset||!measurement||!UUID.test(String(asset.id||""))||
      !UUID.test(String(asset.owner_id||asset.ownerId||""))) {
      return {recorded:false,reason:"asset_resource_attribution_invalid"};
    }
    const ownerId=String(asset.owner_id||asset.ownerId);
    const projectId=asset.project_id||asset.projectId||null;
    if(projectId&&!UUID.test(String(projectId)))return {recorded:false,reason:"asset_resource_project_invalid"};
    const d=measurement.dimensions||{};
    if(d.assetId!==asset.id)return {recorded:false,reason:"asset_resource_measurement_asset_mismatch"};
    const storage=measurement.evidenceMeasurement==="asset_storage_retention_interval";
    const egress=measurement.evidenceMeasurement==="completed_private_asset_http_response";
    if(!storage&&!egress)return {recorded:false,reason:"asset_resource_measurement_type_unsupported"};
    if(!Number.isFinite(measurement.quantity)||measurement.quantity<=0||
      !measurement.measurementId||!measurement.measuredAt)return {recorded:false,reason:"asset_resource_measurement_invalid"};
    const intervalStart=storage?d.intervalStart:null;
    const intervalEnd=storage?d.intervalEnd:null;
    const transferredBytes=egress?d.transferredBytes:null;
    const idempotencyKey="asset-resource:"+hash(measurement.measurementId);
    const result=await rpc("record_asset_resource_measurement",{
      p_actor_id:actorId,p_asset_id:asset.id,p_owner_id:ownerId,p_project_id:projectId,
      p_measurement_id:measurement.measurementId,p_event_kind:storage?"storage_retention":"egress",
      p_resource_type:measurement.resourceType,p_unit:measurement.unit,p_quantity:measurement.quantity,
      p_measured_at:measurement.measuredAt,p_interval_start:intervalStart,p_interval_end:intervalEnd,
      p_transferred_bytes:transferredBytes,p_idempotency_key:idempotencyKey
    });
    return {recorded:true,result};
  }
  return Object.freeze({record});
}
