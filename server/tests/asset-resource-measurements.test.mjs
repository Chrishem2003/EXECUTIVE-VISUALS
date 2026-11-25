import test from "node:test";
import assert from "node:assert/strict";
import {buildAssetEgressMeasurement,buildAssetStorageRetentionMeasurement} from "../asset-resource-measurements.mjs";

const asset={id:"11111111-1111-4111-8111-111111111111",owner_id:"22222222-2222-4222-8222-222222222222",
 project_id:"33333333-3333-4333-8333-333333333333",byte_size:1_000_000_000,created_at:"2026-11-24T00:00:00.000Z"};

test("storage retention measures decimal GB-days over an exact UTC interval",()=>{
 const result=buildAssetStorageRetentionMeasurement({asset,intervalStart:"2026-11-24T00:00:00.000Z",intervalEnd:"2026-11-25T12:00:00.000Z"});
 assert.equal(result.ready,true);
 assert.equal(result.measurement.resourceType,"storage_gb_day");
 assert.equal(result.measurement.unit,"gb_day");
 assert.equal(result.measurement.quantity,1.5);
 assert.equal(result.operationId,asset.id);
 assert.equal(result.measurement.evidenceMeasurement,"asset_storage_retention_interval");
});

test("storage interval rejects invalid, reversed and zero-length intervals",()=>{
 for(const [start,end] of [["bad","2026-11-25T00:00:00Z"],["2026-11-25T00:00:00Z","2026-11-24T00:00:00Z"],["2026-11-25T00:00:00Z","2026-11-25T00:00:00Z"]]){
  assert.equal(buildAssetStorageRetentionMeasurement({asset,intervalStart:start,intervalEnd:end}).ready,false);
 }
});

test("storage retention rejects missing attribution and invalid asset sizes",()=>{
 assert.equal(buildAssetStorageRetentionMeasurement({asset:{...asset,owner_id:null},intervalStart:asset.created_at,intervalEnd:"2026-11-25T00:00:00Z"}).code,"ASSET_RESOURCE_ATTRIBUTION_INVALID");
 assert.equal(buildAssetStorageRetentionMeasurement({asset:{...asset,byte_size:0},intervalStart:asset.created_at,intervalEnd:"2026-11-25T00:00:00Z"}).code,"ASSET_RESOURCE_SIZE_INVALID");
});

test("private asset egress records exact completed response bytes in decimal GB",()=>{
 const result=buildAssetEgressMeasurement({asset,transferredBytes:250_000_000,transferId:"download-request-123",measuredAt:"2026-11-25T12:00:00Z"});
 assert.equal(result.ready,true);
 assert.equal(result.measurement.resourceType,"egress_gb");
 assert.equal(result.measurement.unit,"gb");
 assert.equal(result.measurement.quantity,0.25);
 assert.equal(result.measurement.dimensions.transferredBytes,250_000_000);
});

test("egress rejects partial metadata errors, impossible byte counts and unstable IDs",()=>{
 assert.equal(buildAssetEgressMeasurement({asset,transferredBytes:0,transferId:"download-request-123"}).ready,false);
 assert.equal(buildAssetEgressMeasurement({asset,transferredBytes:asset.byte_size+1,transferId:"download-request-123"}).ready,false);
 assert.equal(buildAssetEgressMeasurement({asset,transferredBytes:1,transferId:"x"}).ready,false);
});

test("equivalent timezone offsets produce one canonical storage interval identity",()=>{
 const utc=buildAssetStorageRetentionMeasurement({asset,intervalStart:"2026-11-24T00:00:00Z",intervalEnd:"2026-11-25T12:00:00Z"});
 const offset=buildAssetStorageRetentionMeasurement({asset,intervalStart:"2026-11-24T03:00:00+03:00",intervalEnd:"2026-11-25T15:00:00+03:00"});
 assert.equal(utc.ready,true);
 assert.equal(offset.ready,true);
 assert.equal(utc.measurement.measurementId,offset.measurement.measurementId);
 assert.equal(utc.measurement.dimensions.intervalStart,offset.measurement.dimensions.intervalStart);
 assert.equal(utc.measurement.dimensions.intervalEnd,offset.measurement.dimensions.intervalEnd);
});
