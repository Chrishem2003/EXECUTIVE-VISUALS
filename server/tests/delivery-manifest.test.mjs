import test from "node:test";
import assert from "node:assert/strict";
import {createDeliveryManifest,verifyDeliveryManifest} from "../delivery-manifest.mjs";
const base={timelineId:"timeline-1",timelineRevision:7,outputAsset:"asset-master",sha256:"a".repeat(64),byteSize:12345,mediaType:"video/mp4",profileId:"youtube-1080p",deliveryReport:{status:"passed",counts:{warnings:0,errors:0}},renderManifest:{fingerprint:"b".repeat(64)},createdAt:"2026-11-02T10:00:00.000Z"};
test("creates deterministic, verifiable delivery evidence",()=>{
 const a=createDeliveryManifest(base),b=createDeliveryManifest({...base,deliveryReport:{counts:{errors:0,warnings:0},status:"passed"}});
 assert.equal(a.fingerprint,b.fingerprint);assert.equal(verifyDeliveryManifest(a),true);
});
test("detects changes to published asset evidence and report",()=>{
 const manifest=createDeliveryManifest(base);
 assert.equal(verifyDeliveryManifest({...manifest,output:{...manifest.output,byteSize:999}}),false);
 assert.equal(verifyDeliveryManifest({...manifest,deliveryReport:{status:"review"}}),false);
});
test("rejects incomplete or unsafe output evidence",()=>{
 assert.throws(()=>createDeliveryManifest({...base,sha256:"bad"}),e=>e.code==="DELIVERY_MANIFEST_CHECKSUM_INVALID");
 assert.throws(()=>createDeliveryManifest({...base,byteSize:0}),e=>e.code==="DELIVERY_MANIFEST_SIZE_INVALID");
 for(const timelineRevision of [-1,0,"0"," 0 ","+0","-0","-0.0","-1","-1.5","1.5","   ","x".repeat(129)]){
  assert.throws(()=>createDeliveryManifest({...base,timelineRevision}),e=>e.code==="DELIVERY_MANIFEST_REVISION_INVALID",String(timelineRevision));
 }
 assert.equal(createDeliveryManifest({...base,timelineRevision:"1"}).timelineRevision,"1");
 assert.equal(createDeliveryManifest({...base,timelineRevision:"revision-abc"}).timelineRevision,"revision-abc");
});
test("rejects a modified fingerprint",()=>{const m=createDeliveryManifest(base);assert.equal(verifyDeliveryManifest({...m,fingerprint:"f".repeat(64)}),false);});
