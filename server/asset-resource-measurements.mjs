import { createHash } from "node:crypto";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GB=1_000_000_000;
const clean=value=>String(value??"").trim();
const validTime=value=>typeof value==="string"&&Number.isFinite(Date.parse(value));
const stableId=value=>createHash("sha256").update(String(value)).digest("hex");

/**
 * Build an immutable storage-retention interval measurement.
 * Uses decimal GB and elapsed UTC time; callers persist the interval cursor only
 * after the remote usage event is accepted. No estimate or zero-cost fallback.
 */
export function buildAssetStorageRetentionMeasurement({asset,intervalStart,intervalEnd,measurementId}={}) {
  const id=clean(asset?.id),ownerId=clean(asset?.owner_id||asset?.ownerId);
  const projectId=asset?.project_id||asset?.projectId||null;
  const bytes=Number(asset?.byte_size??asset?.size);
  if(!UUID.test(id)||!UUID.test(ownerId)||(projectId&&!UUID.test(String(projectId))))
    return {ready:false,code:"ASSET_RESOURCE_ATTRIBUTION_INVALID"};
  if(!Number.isSafeInteger(bytes)||bytes<=0)
    return {ready:false,code:"ASSET_RESOURCE_SIZE_INVALID"};
  if(!validTime(intervalStart)||!validTime(intervalEnd)||Date.parse(intervalEnd)<=Date.parse(intervalStart))
    return {ready:false,code:"ASSET_STORAGE_INTERVAL_INVALID"};
  const elapsedSeconds=(Date.parse(intervalEnd)-Date.parse(intervalStart))/1000;
  const quantity=(bytes/GB)*(elapsedSeconds/86400);
  if(!Number.isFinite(quantity)||quantity<=0)
    return {ready:false,code:"ASSET_STORAGE_QUANTITY_INVALID"};
  const intervalKey=clean(measurementId)||stableId([id,intervalStart,intervalEnd].join("|"));
  return Object.freeze({ready:true,measurement:Object.freeze({
    measurementId:"asset-storage:"+intervalKey,
    measuredAt:new Date(Date.parse(intervalEnd)).toISOString(),
    resourceType:"storage_gb_day",quantity,unit:"gb_day",
    evidenceSource:"worker_instrumentation",evidenceMeasurement:"asset_storage_retention_interval",
    dimensions:Object.freeze({assetId:id,intervalStart:new Date(Date.parse(intervalStart)).toISOString(),
      intervalEnd:new Date(Date.parse(intervalEnd)).toISOString(),bytes,accountingUnit:"decimal_gb_day"})
  }),ownerId,projectId,operationId:id});
}

/** Build an exact HTTP egress measurement from bytes actually completed by the response. */
export function buildAssetEgressMeasurement({asset,transferredBytes,transferId,measuredAt}={}) {
  const id=clean(asset?.id),ownerId=clean(asset?.owner_id||asset?.ownerId);
  const projectId=asset?.project_id||asset?.projectId||null;
  const bytes=Number(transferredBytes),key=clean(transferId),at=measuredAt||new Date().toISOString();
  if(!UUID.test(id)||!UUID.test(ownerId)||(projectId&&!UUID.test(String(projectId))))
    return {ready:false,code:"ASSET_RESOURCE_ATTRIBUTION_INVALID"};
  if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>Number(asset?.byte_size??asset?.size))
    return {ready:false,code:"ASSET_EGRESS_BYTES_INVALID"};
  if(key.length<8||key.length>180||!validTime(at))
    return {ready:false,code:"ASSET_EGRESS_IDENTITY_INVALID"};
  return Object.freeze({ready:true,measurement:Object.freeze({
    measurementId:"asset-egress:"+key,measuredAt:new Date(Date.parse(at)).toISOString(),
    resourceType:"egress_gb",quantity:bytes/GB,unit:"gb",
    evidenceSource:"worker_instrumentation",evidenceMeasurement:"completed_private_asset_http_response",
    dimensions:Object.freeze({assetId:id,transferredBytes:bytes,accountingUnit:"decimal_gb"})
  }),ownerId,projectId,operationId:id});
}
