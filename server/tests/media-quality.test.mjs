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

test("reports audio clipping and near-full-scale peak findings",()=>{
 const report=buildMediaQualityReport({format:{duration:"9"},streams:[
  {codec_type:"audio",sample_rate:"48000",channels:2}
 ],signalAnalysis:{audioMetrics:{clippedSamples:3,peakDbfs:-0.3,rmsDbfs:-18,integratedLufs:-16.5},performed:["audio-metrics"]}});
 assert.equal(report.status,"review");
 assert.ok(report.findings.some(item=>item.code==="AUDIO_CLIPPING"));
 assert.ok(report.findings.some(item=>item.code==="AUDIO_PEAK_NEAR_FULL_SCALE"));
 assert.equal(report.signalAnalysis.audioMetrics.integratedLufs,-16.5);
});

test("marks unavailable signal checks as unknown review warnings",()=>{
 const report=buildMediaQualityReport({format:{duration:"12"},streams:[{codec_type:"video",width:1920,height:1080,avg_frame_rate:"24/1"}],signalAnalysis:{performed:[],unavailable:[{check:"black-frame",reason:"MEDIA_PROCESS_FAILED"}]}},{requireVideo:true});
 assert.equal(report.status,"review");
 assert.ok(report.findings.some(item=>item.code==="SIGNAL_ANALYSIS_UNAVAILABLE"&&item.reason==="MEDIA_PROCESS_FAILED"));
 assert.equal(report.signalAnalysis.unavailable.length,1);
});

test("includes freeze warnings and scene-change timestamps in QA evidence",()=>{
 const report=buildMediaQualityReport({format:{duration:"12"},streams:[{codec_type:"video",width:1920,height:1080,avg_frame_rate:"24/1"}],signalAnalysis:{
  freezes:[{startSeconds:2,endSeconds:5,durationSeconds:3}],sceneChanges:[1.2,4.8],performed:["freeze-detect","scene-change"]
 }},{requireVideo:true});
 assert.equal(report.status,"review");
 assert.ok(report.findings.some(item=>item.code==="FROZEN_VIDEO_INTERVAL"));
 assert.deepEqual(report.signalAnalysis.sceneChangeTimes,[1.2,4.8]);
});

import { captionStyle } from "../media.mjs";
test("caption styles render readable background panels and configurable typography",()=>{const style=captionStyle({fontSize:38,primaryColor:"#F2E8D5",backgroundColor:"#101820",backgroundOpacity:0.7,backgroundMode:"box",outline:2,shadow:1,alignment:2,marginV:54});assert.match(style,/FontSize=38/);assert.match(style,/BorderStyle=3/);assert.match(style,/BackColour=&H4D201810/i);assert.match(style,/Alignment=2/);});
test("caption panels can be disabled without losing text styling",()=>{const style=captionStyle({backgroundMode:"none",fontSize:30});assert.match(style,/BorderStyle=1/);assert.match(style,/FontSize=30/);});

test("preserves neural voice activity segments in media quality evidence",()=>{
 const voiceActivity={method:"silero-neural-vad",model:"silero-v6.2",sampleRate:16000,threshold:0.5,holdoffMs:300,durationSeconds:10,windowCount:312,speechWindowCount:120,speechDurationSeconds:3.8,speechRatio:0.38,segments:[{start:1.2,end:2.4},{start:5.1,end:7.7}]};
 const report=buildMediaQualityReport({format:{duration:"10"},streams:[{codec_type:"audio",codec_name:"aac",sample_rate:"48000",channels:2}],signalAnalysis:{method:"ffmpeg-and-silero-vad",performed:["silero-vad"],voiceActivity}});
 assert.deepEqual(report.signalAnalysis.voiceActivity,voiceActivity);
 assert.equal(report.signalAnalysis.performed.includes("silero-vad"),true);
});
