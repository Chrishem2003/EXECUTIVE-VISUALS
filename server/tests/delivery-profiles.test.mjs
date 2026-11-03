import test from "node:test";
import assert from "node:assert/strict";
import {getDeliveryProfile,listDeliveryProfiles,evaluateDeliveryOutput} from "../delivery-profiles.mjs";

const valid={format:{duration:"30"},streams:[
 {codec_type:"video",codec_name:"h264",width:1920,height:1080,pix_fmt:"yuv420p",avg_frame_rate:"30/1"},
 {codec_type:"audio",codec_name:"aac",sample_rate:"48000"}
]};
test("lists isolated delivery profiles and returns a passed YouTube 1080p report",()=>{
 assert.ok(listDeliveryProfiles().length>=4);
 assert.equal(evaluateDeliveryOutput(valid,"youtube-1080p").status,"passed");
 const copy=getDeliveryProfile("youtube-1080p");copy.width=1;
 assert.equal(getDeliveryProfile("youtube-1080p").width,1920);
});
test("reports exact export mismatches rather than silently accepting them",()=>{
 const report=evaluateDeliveryOutput({...valid,streams:[{...valid.streams[0],width:1280,avg_frame_rate:"24/1"},valid.streams[1]]},"youtube-1080p");
 assert.equal(report.status,"needs-attention");
 assert.ok(report.findings.some(x=>x.code==="VIDEO_DIMENSIONS_MISMATCH"));
 assert.ok(report.findings.some(x=>x.code==="FRAME_RATE_MISMATCH"));
});
test("requires audio for social delivery and flags missing duration",()=>{
 const report=evaluateDeliveryOutput({format:{duration:"0"},streams:[valid.streams[0]]},"social-vertical");
 assert.ok(report.findings.some(x=>x.code==="AUDIO_STREAM_MISSING"));
 assert.ok(report.findings.some(x=>x.code==="INVALID_DURATION"));
});
test("broadcast review profile treats unavailable loudness as review, not a false pass",()=>{
 const report=evaluateDeliveryOutput({...valid,streams:[{...valid.streams[0],width:1920,height:1080,avg_frame_rate:"25/1"},valid.streams[1]]},"broadcast-1080p25");
 assert.equal(report.status,"review");
 assert.ok(report.findings.some(x=>x.code==="LOUDNESS_UNAVAILABLE"));
});
test("rejects unknown delivery profiles",()=>{
 assert.throws(()=>getDeliveryProfile("made-up"),error=>error.code==="DELIVERY_PROFILE_UNKNOWN");
});

test("includes square, landscape, 1440p and lightweight web delivery targets",()=>{
 const profiles=listDeliveryProfiles();
 for(const id of ["instagram-square","social-landscape","youtube-1440p","web-720p"])assert.ok(profiles.some(profile=>profile.id===id));
 assert.deepEqual([getDeliveryProfile("instagram-square").width,getDeliveryProfile("instagram-square").height],[1080,1080]);
 assert.deepEqual([getDeliveryProfile("youtube-1440p").width,getDeliveryProfile("youtube-1440p").height],[2560,1440]);
 assert.deepEqual([getDeliveryProfile("web-720p").width,getDeliveryProfile("web-720p").height],[1280,720]);
});
