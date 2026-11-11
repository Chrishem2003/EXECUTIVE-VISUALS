import test from "node:test";
import assert from "node:assert/strict";
import {analyzeVoiceActivityFile,normalizeVoiceActivityReport} from "../voice-activity-detection.mjs";

const report={
 scores:[
  {start:0,end:0.032,vadScore:0.03,isSpeech:false},
  {start:0.032,end:0.064,vadScore:0.92,isSpeech:true},
  {start:0.064,end:0.096,vadScore:0.88,isSpeech:true},
  {start:0.096,end:0.128,vadScore:0.1,isSpeech:false}
 ],
 segments:[{start:0.032,end:0.096},{start:0.09,end:0.12}]
};

test("normalizes Silero scores and merges overlapping speech regions",()=>{
 const result=normalizeVoiceActivityReport(report,{durationSeconds:1});
 assert.equal(result.method,"silero-neural-vad");
 assert.equal(result.model,"silero-v6.2");
 assert.equal(result.sampleRate,16000);
 assert.equal(result.windowCount,4);
 assert.equal(result.speechWindowCount,2);
 assert.deepEqual(result.segments,[{start:0.032,end:0.12}]);
 assert.equal(result.speechDurationSeconds,0.088);
 assert.equal(result.speechRatio,0.088);
});
test("clamps small model timestamp drift to the known media duration",()=>{
 const result=normalizeVoiceActivityReport({scores:[{start:0.9,end:1.1,vadScore:0.8,isSpeech:true}],segments:[{start:0.9,end:1.1}]},{durationSeconds:1});
 assert.deepEqual(result.segments,[{start:0.9,end:1}]);
});
test("rejects malformed or out-of-range model reports",()=>{
 assert.throws(()=>normalizeVoiceActivityReport({}, {durationSeconds:10}),/invalid report/);
 assert.throws(()=>normalizeVoiceActivityReport({scores:[{start:0,end:1,vadScore:1.2,isSpeech:true}],segments:[]},{durationSeconds:10}),/invalid score/);
 assert.throws(()=>normalizeVoiceActivityReport({scores:[],segments:[{start:4,end:3}]},{durationSeconds:10}),/invalid speech segment/);
 assert.throws(()=>normalizeVoiceActivityReport({scores:[],segments:[]},{durationSeconds:0}),/durationSeconds/);
});
test("uses the Silero model with bounded options and closes the file handle",async()=>{
 let received,closed=false;
 const result=await analyzeVoiceActivityFile({
  filePath:"/tmp/audio.wav",durationSeconds:1,threshold:0.6,holdoffMs:250,
  openFile:async(path,options)=>{received={path,options};return {analyze:async()=>report,close:()=>{closed=true;}};}
 });
 assert.equal(received.path,"/tmp/audio.wav");
 assert.deepEqual(received.options,{sampleRate:16000,channels:1,vad:{model:"silero",threshold:0.6,holdoffMs:250}});
 assert.equal(closed,true);
 assert.equal(result.threshold,0.6);
});
test("closes the file handle when inference fails",async()=>{
 let closed=false;
 await assert.rejects(()=>analyzeVoiceActivityFile({
  filePath:"/tmp/audio.wav",durationSeconds:1,
  openFile:async()=>({analyze:async()=>{throw new Error("inference failed");},close:()=>{closed=true;}})
 }),/inference failed/);
 assert.equal(closed,true);
});
