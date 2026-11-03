import test from "node:test";
import assert from "node:assert/strict";
import {buildAudioDuckingGraph,normalizeDuckingSettings} from "../audio-ducking.mjs";

test("audio ducking is opt-in and leaves ordinary audio mix labels untouched",()=>{
 const graph=buildAudioDuckingGraph([{label:"a0",role:"voice"},{label:"a1",role:"music",duckingEnabled:false}]);
 assert.deepEqual(graph,{filters:[],outputLabels:["a0","a1"],duckedClips:0});
});
test("music is compressed against the voice sidechain with bounded settings",()=>{
 const graph=buildAudioDuckingGraph([
  {label:"voice",role:"voice"},
  {label:"music",role:"music",duckingEnabled:true,settings:{thresholdDb:-100,ratio:100,attackMs:0,releaseMs:9000}}
 ]);
 assert.equal(graph.duckedClips,1);
 assert.deepEqual(graph.outputLabels,["voice","ducked-music-0"]);
 assert.match(graph.filters[0],/sidechaincompress=threshold=0\.001000:ratio=20\.00:attack=1\.0:release=2000\.0/);
});
test("multiple voice clips share one sidechain bus for music ducking",()=>{
 const graph=buildAudioDuckingGraph([
  {label:"voice-a",role:"voice"},{label:"voice-b",role:"voice"},
  {label:"music-a",role:"music",duckingEnabled:true},{label:"music-b",role:"music",duckingEnabled:true}
 ]);
 assert.equal(graph.duckedClips,2);
 assert.match(graph.filters[0],/amix=inputs=2/);
 assert.match(graph.filters[1],/\[ducking-voice-bus\]sidechaincompress/);
 assert.match(graph.filters[2],/\[ducking-voice-bus\]sidechaincompress/);
});
test("ducking settings use safe defaults for malformed metadata",()=>{
 assert.deepEqual(normalizeDuckingSettings({duckingThresholdDb:"bad"}),{thresholdDb:-24,ratio:8,attackMs:20,releaseMs:300});
});
