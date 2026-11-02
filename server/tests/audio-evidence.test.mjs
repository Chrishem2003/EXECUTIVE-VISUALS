import test from "node:test";
import assert from "node:assert/strict";
import { createTimeline, addTrack, addClip, rational } from "../../src/core/timeline.ts";
import { assessAudioEvidence } from "../../src/core/audio-evidence.ts";
function timeline(){let t=createTimeline("p","t","Audio");t=addTrack(t,{id:"a",name:"Music",kind:"audio",enabled:true,locked:false,clips:[]});return addClip(t,"a",{id:"c",assetId:"source",name:"Music",sourceRange:{start:rational(0,24),duration:rational(48,24)},timelineStart:rational(0,24),duration:rational(48,24),enabled:true});}
const audio=(signalAnalysis)=>({id:"source",metadata:{probe:{format:{duration:"10"},streams:[{codec_type:"audio",sample_rate:"48000",channels:2}]},...(signalAnalysis?{signalAnalysis}:{})}});
test("no audio clips remain not-run",()=>assert.equal(assessAudioEvidence(null,[]).status,"not_run"));
test("missing audio source or required audio stream blocks",()=>{assert.equal(assessAudioEvidence(timeline(),[]).status,"blocked");assert.equal(assessAudioEvidence(timeline(),[{id:"source",metadata:{probe:{format:{duration:"10"},streams:[{codec_type:"video"}]}}}]).status,"blocked");});
test("probe without signal measurements remains not-run",()=>{const r=assessAudioEvidence(timeline(),[audio()]);assert.equal(r.status,"not_run");assert.ok(r.findings.some(x=>x.code==="AUDIO_SIGNAL_NOT_RUN"));});
test("clean measured audio passes without inventing a loudness target",()=>assert.equal(assessAudioEvidence(timeline(),[audio({audioMetrics:{clippedSamples:0,peakDbfs:-6,integratedLufs:-16}})]).status,"passed"));
test("clipping and near-full-scale peaks require review",()=>{const r=assessAudioEvidence(timeline(),[audio({audioMetrics:{clippedSamples:2,peakDbfs:-0.5}})]);assert.equal(r.status,"review");assert.equal(r.findings.length,2);});
