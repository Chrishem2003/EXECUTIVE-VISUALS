import test from "node:test";
import assert from "node:assert/strict";
import {createAssetEgressAttemptJournal} from "../asset-egress-attempt-journal.mjs";
const actor="44444444-4444-4444-8444-444444444444";
const transfer="55555555-5555-4555-8555-555555555555";
const asset={id:"11111111-1111-4111-8111-111111111111",owner_id:"22222222-2222-4222-8222-222222222222",project_id:"33333333-3333-4333-8333-333333333333"};
test("journals transfer intent before any bytes are sent",async()=>{
 const calls=[];const journal=createAssetEgressAttemptJournal({actorId:actor,enabled:true,rpc:async(name,args)=>{calls.push({name,args});return {status:"started"};}});
 const result=await journal.begin({asset,transferId:transfer});
 assert.equal(result.recorded,true);assert.equal(calls[0].name,"begin_asset_egress_transfer_attempt");
 assert.equal(calls[0].args.p_transfer_id,transfer);assert.equal(calls[0].args.p_asset_id,asset.id);
});
test("finalizes completed and partial outcomes with exact measured bytes",async()=>{
 const calls=[];const journal=createAssetEgressAttemptJournal({actorId:actor,enabled:true,rpc:async(name,args)=>{calls.push({name,args});return {status:args.p_status};}});
 await journal.finish({transferId:transfer,status:"partial",transferredBytes:1234,upstreamStatus:206,measurementId:"asset-egress:"+transfer});
 assert.equal(calls[0].name,"finish_asset_egress_transfer_attempt");
 assert.equal(calls[0].args.p_transferred_bytes,1234);assert.equal(calls[0].args.p_status,"partial");
});
test("fails closed on invalid attribution and transfer outcome",async()=>{
 const journal=createAssetEgressAttemptJournal({actorId:actor,enabled:true,rpc:async()=>{throw new Error("must not call");}});
 await assert.rejects(()=>journal.begin({asset:{id:"bad",owner_id:actor}}),/attribution/);
 await assert.rejects(()=>journal.finish({transferId:transfer,status:"completed",transferredBytes:-1}),/outcome/);
});
test("disabled journal makes no database calls",async()=>{
 const journal=createAssetEgressAttemptJournal({enabled:false,rpc:async()=>{throw new Error("must not call");}});
 assert.equal((await journal.begin({asset})).recorded,false);
});
