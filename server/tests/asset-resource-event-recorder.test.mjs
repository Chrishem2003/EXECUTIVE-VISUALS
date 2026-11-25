import test from "node:test";
import assert from "node:assert/strict";
import {createAssetResourceEventRecorder} from "../asset-resource-event-recorder.mjs";
import {buildAssetEgressMeasurement,buildAssetStorageRetentionMeasurement} from "../asset-resource-measurements.mjs";

const asset={id:"11111111-1111-4111-8111-111111111111",owner_id:"22222222-2222-4222-8222-222222222222",
 project_id:"33333333-3333-4333-8333-333333333333",byte_size:1_000_000_000,created_at:"2026-11-24T00:00:00.000Z"};
const actorId="44444444-4444-4444-8444-444444444444";

test("recorder persists asset-scoped storage evidence without inventing a job ID",async()=>{
 let call;
 const recorder=createAssetResourceEventRecorder({actorId,enabled:true,rpc:async(name,args)=>{call={name,args};return {idempotentReplay:false};}});
 const built=buildAssetStorageRetentionMeasurement({asset,intervalStart:asset.created_at,intervalEnd:"2026-11-25T00:00:00Z"});
 const result=await recorder.record({asset,measurement:built.measurement});
 assert.equal(result.recorded,true);
 assert.equal(call.name,"record_asset_resource_measurement");
 assert.equal(call.args.p_asset_id,asset.id);
 assert.equal(call.args.p_owner_id,asset.owner_id);
 assert.equal(call.args.p_project_id,asset.project_id);
 assert.equal("p_job_id" in call.args,false);
 assert.equal(call.args.p_event_kind,"storage_retention");
 assert.equal(call.args.p_interval_start,asset.created_at);
 assert.equal(call.args.p_interval_end,"2026-11-25T00:00:00.000Z");
});

test("recorder sends completed-byte egress evidence with stable idempotency",async()=>{
 const calls=[];
 const recorder=createAssetResourceEventRecorder({actorId,enabled:true,rpc:async(name,args)=>{calls.push(args);return {}; }});
 const built=buildAssetEgressMeasurement({asset,transferredBytes:250_000_000,transferId:"transfer-000123"});
 await recorder.record({asset,measurement:built.measurement});
 await recorder.record({asset,measurement:built.measurement});
 assert.equal(calls.length,2);
 assert.equal(calls[0].p_event_kind,"egress");
 assert.equal(calls[0].p_transferred_bytes,250_000_000);
 assert.equal(calls[0].p_idempotency_key,calls[1].p_idempotency_key);
 assert.equal(calls[0].p_interval_start,null);
});

test("recorder fails closed when disabled or attribution is invalid",async()=>{
 const disabled=createAssetResourceEventRecorder({actorId,enabled:false,rpc:async()=>{throw new Error("must not call");}});
 const built=buildAssetEgressMeasurement({asset,transferredBytes:10,transferId:"transfer-000124"});
 assert.deepEqual(await disabled.record({asset,measurement:built.measurement}),{recorded:false,reason:"resource_cost_metering_disabled"});
 const enabled=createAssetResourceEventRecorder({actorId,enabled:true,rpc:async()=>{throw new Error("must not call");}});
 assert.equal((await enabled.record({asset:{...asset,owner_id:null},measurement:built.measurement})).reason,"asset_resource_attribution_invalid");
 assert.equal((await enabled.record({asset,measurement:{...built.measurement,dimensions:{...built.measurement.dimensions,assetId:"55555555-5555-4555-8555-555555555555"}}})).reason,"asset_resource_measurement_asset_mismatch");
});

test("canonical UTC storage intervals produce the same event identity",()=>{
 const a=buildAssetStorageRetentionMeasurement({asset,intervalStart:"2026-11-24T00:00:00Z",intervalEnd:"2026-11-25T00:00:00Z"});
 const b=buildAssetStorageRetentionMeasurement({asset,intervalStart:"2026-11-24T03:00:00+03:00",intervalEnd:"2026-11-25T03:00:00+03:00"});
 assert.equal(a.measurement.measurementId,b.measurement.measurementId);
 assert.equal(a.measurement.dimensions.intervalStart,b.measurement.dimensions.intervalStart);
 assert.equal(a.measurement.quantity,b.measurement.quantity);
});
