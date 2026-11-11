import test from "node:test";
import assert from "node:assert/strict";
import { createTimeline,addTrack,addClip,normalizeAudioMasteringSettings,rational } from "../../src/core/timeline.ts";
import { assessDeliveryEvidence } from "../../src/core/delivery-evidence.ts";
function timeline(withAudio=false){let t=createTimeline("p","timeline","Delivery");t.width=1920;t.height=1080;t.frameRate={numerator:24,denominator:1};t=addTrack(t,{id:"v",name:"Video",kind:"video",enabled:true,locked:false,clips:[]});t=addClip(t,"v",{id:"vc",assetId:"source",name:"Shot",sourceRange:{start:rational(0,24),duration:rational(48,24)},timelineStart:rational(0,24),duration:rational(48,24),enabled:true});if(withAudio){t=addTrack(t,{id:"a",name:"Audio",kind:"audio",enabled:true,locked:false,clips:[]});t=addClip(t,"a",{id:"ac",assetId:"audio",name:"Music",sourceRange:{start:rational(0,24),duration:rational(48,24)},timelineStart:rational(0,24),duration:rational(48,24),enabled:true});}return t;}
function master(t,overrides={}){return{id:"master",metadata:{operation:"timeline.render",timelineId:t.id,timelineRevision:t.revision,render:{durationSeconds:2},probe:{format:{format_name:"mov,mp4,m4a,3gp,3g2,mj2",duration:"2"},streams:[{codec_type:"video",codec_name:"h264",width:1920,height:1080,avg_frame_rate:"24/1"},{codec_type:"audio",codec_name:"aac"}]},...overrides}};}
test("no current-revision master or probe evidence cannot pass",()=>{const t=timeline();assert.equal(assessDeliveryEvidence(t,[]).status,"not_run");assert.equal(assessDeliveryEvidence(t,[{id:"m",metadata:{operation:"timeline.render",timelineId:t.id,timelineRevision:t.revision}}]).status,"not_run");});
test("a probed master matching sequence-native profile passes",()=>{const t=timeline();const r=assessDeliveryEvidence(t,[master(t)]);assert.equal(r.status,"passed");assert.equal(r.measured?.videoCodec,"h264");assert.equal(r.measured?.frameRate,24);});
test("enabled mastering requires measured post-encode audio QC before delivery passes",()=>{
 const t=timeline(true);t.audioMastering=normalizeAudioMasteringSettings({enabled:true,profile:"ebu-r128"});
 const receipt={applied:true,profile:"ebu-r128",measurement:{integratedLoudness:-23.1,loudnessRange:4.2,truePeak:-1.2},qualityControl:{passed:true}};
 const r=assessDeliveryEvidence(t,[master(t,{render:{durationSeconds:2,audioMastering:receipt}})]);
 assert.equal(r.status,"passed");
 assert.deepEqual(r.measured?.audioMastering,{profile:"ebu-r128",integratedLoudness:-23.1,loudnessRange:4.2,truePeak:-1.2,passed:true});
});
test("missing or failed mastering QC cannot certify an enabled mastering delivery",()=>{
 const t=timeline(true);t.audioMastering=normalizeAudioMasteringSettings({enabled:true,profile:"ebu-r128"});
 const missing=assessDeliveryEvidence(t,[master(t)]);
 assert.equal(missing.status,"review");
 assert.ok(missing.findings.some(x=>x.code==="DELIVERY_AUDIO_MASTERING_NOT_APPLIED"));
 const missingMeasurement=assessDeliveryEvidence(t,[master(t,{render:{durationSeconds:2,audioMastering:{applied:true,profile:"ebu-r128",measurement:{integratedLoudness:null,loudnessRange:null,truePeak:null},qualityControl:{passed:true}}}})]);
 assert.equal(missingMeasurement.status,"review","null measurements must never be coerced to zero and accepted");
 assert.ok(missingMeasurement.findings.some(x=>x.code==="DELIVERY_AUDIO_MASTERING_QC_MISSING"));
 const failed=assessDeliveryEvidence(t,[master(t,{render:{durationSeconds:2,audioMastering:{applied:true,profile:"ebu-r128",measurement:{integratedLoudness:-21,loudnessRange:4,truePeak:-0.4},qualityControl:{passed:false}}}})]);
 assert.equal(failed.status,"review");
 assert.ok(failed.findings.some(x=>x.code==="DELIVERY_AUDIO_MASTERING_QC_FAILED"));
});

test("missing required audio blocks delivery when the sequence has audio",()=>{const t=timeline(true),m=master(t);m.metadata.probe.streams=m.metadata.probe.streams.filter(x=>x.codec_type!=="audio");assert.equal(assessDeliveryEvidence(t,[m]).status,"review");});
test("explicit delivery profile mismatches block certification",()=>{const t=timeline();t.metadata={deliverySpec:{container:"mp4",videoCodec:"h265",width:3840,height:2160,frameRate:60,requireAudio:true}};const m=master(t);m.metadata.probe.streams=m.metadata.probe.streams.filter(x=>x.codec_type!=="audio");const r=assessDeliveryEvidence(t,[m]);assert.equal(r.status,"blocked");assert.ok(r.findings.some(x=>x.code==="DELIVERY_VIDEO_CODEC_MISMATCH"));assert.ok(r.findings.some(x=>x.code==="DELIVERY_WIDTH_MISMATCH"));assert.ok(r.findings.some(x=>x.code==="DELIVERY_AUDIO_STREAM_MISSING"));});
test("stale master revision is never accepted for the current timeline",()=>{const t=timeline(),m=master(t);m.metadata.timelineRevision=t.revision-1;assert.equal(assessDeliveryEvidence(t,[m]).status,"not_run");});
test("renderer and measured duration divergence is reviewed",()=>{const t=timeline(),m=master(t);m.metadata.probe.format.duration="3";assert.ok(assessDeliveryEvidence(t,[m]).findings.some(x=>x.code==="DELIVERY_DURATION_DIVERGENCE"));});
