import test from "node:test";
import assert from "node:assert/strict";
import {buildAudioDuckingGraph,normalizeDuckingSettings} from "../audio-ducking.mjs";
test("audio ducking is opt-in and leaves ordinary audio mix labels untouched",()=>{
 const graph=buildAudioDuckingGraph([{label:"a0",role:"voice"},{label:"a1",role:"music",duckingEnabled:false}]);
 assert.deepEqual(graph,{filters:[],outputLabels:["a0","a1"],duckedClips:0});
});
test("music is compressed against the voice sidechain with bounded settings",()=>{
 const graph=buildAudioDuckingGraph([{label:"voice",role:"voice"},{label:"music",role:"music",duckingEnabled:true,settings:{thresholdDb:-100,ratio:100,attackMs:0,releaseMs:9000}}]);
 assert.equal(graph.duckedClips,1);assert.deepEqual(graph.outputLabels,["voice-main-0","ducked-music-0"]);
 assert.ok(graph.filters[0].includes("asplit=2[voice-main-0][voice-sidechain-0]"));
 assert.ok(graph.filters[1].includes("sidechaincompress=threshold=0.001000:ratio=20.00:attack=1.0:release=2000.0"));
});
test("multiple voice clips share one sidechain bus for music ducking",()=>{
 const graph=buildAudioDuckingGraph([{label:"voice-a",role:"voice"},{label:"voice-b",role:"voice"},{label:"music-a",role:"music",duckingEnabled:true},{label:"music-b",role:"music",duckingEnabled:true}]);
 assert.equal(graph.duckedClips,2);assert.ok(graph.filters[0].includes("asplit=2"));assert.ok(graph.filters[1].includes("asplit=2"));assert.ok(graph.filters[2].includes("amix=inputs=2"));
 assert.ok(graph.filters[3].includes("[ducking-voice-bus]sidechaincompress"));assert.ok(graph.filters[4].includes("[ducking-voice-bus]sidechaincompress"));
});
test("ducking settings use safe defaults for malformed metadata",()=>{
 assert.deepEqual(normalizeDuckingSettings({duckingThresholdDb:"bad"}),{thresholdDb:-24,ratio:8,attackMs:20,releaseMs:300});
});
test("normalized ducking settings survive the renderer-to-filter boundary",()=>{
 const settings=normalizeDuckingSettings({duckingThresholdDb:-30,duckingRatio:10,duckingAttackMs:12,duckingReleaseMs:450});
 assert.deepEqual(normalizeDuckingSettings(settings),{thresholdDb:-30,ratio:10,attackMs:12,releaseMs:450});
 const graph=buildAudioDuckingGraph([{label:"voice",role:"voice"},{label:"music",role:"music",duckingEnabled:true,settings}]);
 assert.ok(graph.filters[1].includes("threshold=0.031623:ratio=10.00:attack=12.0:release=450.0"));
});
