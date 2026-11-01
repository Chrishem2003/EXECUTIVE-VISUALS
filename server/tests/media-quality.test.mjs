import test from "node:test";
import assert from "node:assert/strict";
import {buildMediaQualityReport} from "../media-quality.mjs";

test("reports valid HD audio-video media as structurally passed",()=>{
 const report=buildMediaQualityReport({format:{duration:"42.5"},streams:[
  {codec_type:"video",codec_name:"h264",width:1920,height:1080,avg_frame_rate:"30/1"},
  {codec_type:"audio",codec_name:"aac",sample_rate:"48000",channels:2}
 ]},{requireVideo:true,requireAudio:true});
 assert.equal(report.status,"passed");
 assert.equal(report.durationSeconds,42.5);
 assert.deepEqual(report.streams,{total:2,video:1,audio:1});
 assert.equal(report.findings.length,0);
 assert.ok(report.limitations.some(item=>item.includes("perceptual quality")));
});

test("flags missing streams, invalid duration and low resolution",()=>{
 const report=buildMediaQualityReport({format:{duration:"0"},streams:[
  {codec_type:"video",width:640,height:360,avg_frame_rate:"0/0"}
 ]},{requireVideo:true,requireAudio:true});
 assert.equal(report.status,"needs-attention");
 assert.ok(report.findings.some(item=>item.code==="INVALID_DURATION"));
 assert.ok(report.findings.some(item=>item.code==="AUDIO_STREAM_MISSING"));
 assert.ok(report.findings.some(item=>item.code==="BELOW_HD"));
 assert.ok(report.findings.some(item=>item.code==="INVALID_FRAME_RATE"));
});

test("does not classify audio-only media as missing video unless requested",()=>{
 const report=buildMediaQualityReport({format:{duration:"10"},streams:[
  {codec_type:"audio",codec_name:"pcm_s16le",sample_rate:"44100",channels:2}
 ]});
 assert.equal(report.status,"passed");
 assert.equal(report.streams.audio,1);
});

test("includes detected black frames and silence as review findings",()=>{
 const report=buildMediaQualityReport({format:{duration:"12"},streams:[
  {codec_type:"video",width:1920,height:1080,avg_frame_rate:"25/1"},
  {codec_type:"audio",sample_rate:"48000",channels:2}
 ],signalAnalysis:{
  method:"ffmpeg-blackdetect-silencedetect",performed:["black-frame","silence"],
  blackFrames:[{startSeconds:0,endSeconds:1.5,durationSeconds:1.5}],
  silence:[{startSeconds:4,endSeconds:7,durationSeconds:3}]
 }},{requireVideo:true,requireAudio:true});
 assert.equal(report.status,"review");
 assert.ok(report.findings.some(item=>item.code==="SUSTAINED_BLACK_FRAME"));
 assert.ok(report.findings.some(item=>item.code==="SUSTAINED_SILENCE"));
 assert.deepEqual(report.signalAnalysis.performed,["black-frame","silence"]);
});
