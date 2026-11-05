import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAudioAutomation, evaluateAudioAutomation, buildAudioAutomationExpression, buildGainAutomationExpression, audioPanExpressions } from "../../src/core/audio-automation.ts";

const points=[
 {timeSeconds:1,gainDb:-12,pan:-1,interpolation:"linear"},
 {timeSeconds:3,gainDb:-24,pan:1,interpolation:"step"}
];

test("normalizes, clamps and orders audio automation keyframes",()=>{
 const result=normalizeAudioAutomation([{timeSeconds:2,gainDb:40,pan:2},{timeSeconds:1,gainDb:-80,pan:-2}]);
 assert.deepEqual(result.map(point=>point.timeSeconds),[1,2]);
 assert.equal(result[0].gainDb,-60);assert.equal(result[0].pan,-1);
 assert.equal(result[1].gainDb,24);assert.equal(result[1].pan,1);
});
test("rejects duplicate, malformed and excessive audio keyframes",()=>{
 assert.throws(()=>normalizeAudioAutomation([{timeSeconds:1,gainDb:0},{timeSeconds:1,pan:0}]),/unique/);
 assert.throws(()=>normalizeAudioAutomation([{timeSeconds:-1,gainDb:0}]),/time/);
 assert.throws(()=>normalizeAudioAutomation([{timeSeconds:1}]),/define gain or pan/);
 assert.throws(()=>normalizeAudioAutomation(Array.from({length:257},(_,i)=>({timeSeconds:i,gainDb:0}))),/256/);
});
test("evaluates gain and pan between keyframes using step and linear interpolation",()=>{
 assert.equal(evaluateAudioAutomation(points,0,"gainDb",0),0);
 assert.ok(Math.abs(evaluateAudioAutomation(points,.5,"gainDb",0)+6)<1e-9);
 assert.ok(Math.abs(evaluateAudioAutomation(points,2,"gainDb",0)+18)<1e-9);
 assert.equal(evaluateAudioAutomation(points,2,"pan",0),0);
 assert.equal(evaluateAudioAutomation(points,3,"pan",0),1);
 assert.equal(evaluateAudioAutomation(points,4,"gainDb",0),-24);
});
test("builds safe FFmpeg expressions for gain and stereo pan automation",()=>{
 const gain=buildGainAutomationExpression(points,0);
 assert.match(gain,/if\(lt\(t,1\)/);
 assert.match(gain,/0\.251188643/);
 const pan=audioPanExpressions(points,0);
 assert.match(pan.left,/if\(gt/);assert.match(pan.right,/if\(lt/);
 assert.equal(buildAudioAutomationExpression([], "pan",.25),"0.25");
});
