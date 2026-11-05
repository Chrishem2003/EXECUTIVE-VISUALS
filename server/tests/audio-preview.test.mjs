import test from "node:test";
import assert from "node:assert/strict";
import {AudioPreviewEngine,decibelsToGain,extractWaveformPeaks,waveformSvg} from "../../src/core/audio-preview.ts";

test("decibel conversion clamps unsafe and out-of-range values",()=>{
 assert.equal(decibelsToGain(0),1);
 assert.ok(Math.abs(decibelsToGain(-6)-0.501187)<0.00001);
 assert.equal(decibelsToGain(40),Math.pow(10,24/20));
 assert.equal(decibelsToGain(Number.NaN),1);
});

test("waveform peaks combine channels and preserve silence",()=>{
 const channels=[Float32Array.from([0,.2,-.4,0,.1]),Float32Array.from([0,-.1,.8,0,0])];
 const peaks=extractWaveformPeaks({length:5,numberOfChannels:2,getChannelData:index=>channels[index]},3);
 assert.deepEqual(peaks,[0,.8,.1]);
 assert.throws(()=>extractWaveformPeaks({length:0,numberOfChannels:1,getChannelData:()=>new Float32Array()},3),/empty/);
 assert.throws(()=>extractWaveformPeaks({length:5,numberOfChannels:1,getChannelData:()=>channels[0]},0),/bucket count/);
});

test("waveform SVG emits bounded geometry from numeric peaks",()=>{
 const svg=waveformSvg([0,.5,1],120,40);
 assert.match(svg,/viewBox="0 0 120 40"/);
 assert.equal((svg.match(/<rect /g)||[]).length,3);
 assert.doesNotMatch(svg,/<script|onload=/i);
 assert.throws(()=>waveformSvg([1],5000,40),/dimensions/);
});

class Param{
 value=1;events=[];
 setValueAtTime(value,time){this.value=value;this.events.push([value,time]);}
 setTargetAtTime(value,time,constant){this.value=value;this.events.push([value,time,constant]);}
}
class Node{
 connections=[];gain=new Param();threshold=new Param();knee=new Param();ratio=new Param();attack=new Param();release=new Param();
 connect(node){this.connections.push(node);return node;}
 disconnect(){this.connections=[];}
}
class FakeContext{
 state="running";currentTime=1;destination=new Node();sources=[];
 createGain(){return new Node();}
 createDynamicsCompressor(){return new Node();}
 createMediaElementSource(media){const node=new Node();node.media=media;this.sources.push(node);return node;}
 async resume(){this.state="running";}
 async close(){this.state="closed";}
}

test("audio engine routes tracks, applies solo/mute, restores gain and master mute",()=>{
 const context=new FakeContext(),engine=new AudioPreviewEngine(context);
 const mediaA={pause(){this.paused=true;}},mediaB={pause(){this.paused=true;}};
 engine.sync([
  {id:"a",media:mediaA,gainDb:-6},
  {id:"b",media:mediaB,gainDb:6,solo:true}
 ]);
 assert.equal(context.sources.length,2);
 assert.equal(engine["connected"].get("a").gain.gain.value,0);
 assert.ok(Math.abs(engine["connected"].get("b").gain.gain.value-Math.pow(10,6/20))<0.00001);
 engine.setTrackGain("a",-12);
 engine.sync([{id:"a",media:mediaA,gainDb:-12},{id:"b",media:mediaB,gainDb:6,solo:false}]);
 assert.ok(Math.abs(engine["connected"].get("a").gain.gain.value-Math.pow(10,-12/20))<0.00001);
 engine.setMasterVolume(.4);assert.equal(engine["master"].gain.value,.4);
 engine.setMasterMuted(true);assert.equal(engine["master"].gain.value,0);
 engine.setMasterMuted(false);assert.equal(engine["master"].gain.value,.4);
 engine.sync([{id:"b",media:mediaB,gainDb:6}]);
 assert.equal(mediaA.paused,true);
 assert.equal(context.sources.length,2);
 engine.dispose();assert.equal(context.state,"closed");
});
