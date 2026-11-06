import test from "node:test";
import assert from "node:assert/strict";
import {parseBlackFrameEvents,parseSilenceEvents,buildMediaSignalFindings,parseAudioMetrics,buildAudioMetricFindings,parseFreezeEvents,parseSceneChangeTimes,runOptionalSignalCheck,buildNonSilenceActivityIntervals} from "../media-signal-analysis.mjs";

test("parses FFmpeg blackdetect intervals",()=>{
 const events=parseBlackFrameEvents("[blackdetect @ 0x1] black_start:0.500 black_end:2.000 black_duration:1.500");
 assert.deepEqual(events,[{startSeconds:0.5,endSeconds:2,durationSeconds:1.5}]);
});
test("parses FFmpeg silencedetect intervals",()=>{
 const events=parseSilenceEvents("[silencedetect @ 0x1] silence_start:4.000\n[silencedetect @ 0x1] silence_end:7.250 | silence_duration:3.250");
 assert.deepEqual(events,[{startSeconds:4,endSeconds:7.25,durationSeconds:3.25}]);
});
test("only flags intervals above configured thresholds",()=>{
 const findings=buildMediaSignalFindings({
  blackFrames:[{startSeconds:0,endSeconds:0.4,durationSeconds:0.4},{startSeconds:8,endSeconds:10,durationSeconds:2}],
  silence:[{startSeconds:2,endSeconds:5,durationSeconds:3}],durationSeconds:10
 });
 assert.equal(findings.filter(item=>item.code==="SUSTAINED_BLACK_FRAME").length,1);
 assert.equal(findings.filter(item=>item.code==="SUSTAINED_SILENCE").length,1);
 assert.ok(findings.some(item=>item.code==="BLACK_AT_END"));
});

test("closes trailing silence against the known media duration",()=>{
 const events=parseSilenceEvents("[silencedetect @ 0x1] silence_start:8.000",12);
 assert.deepEqual(events,[{startSeconds:8,endSeconds:12,durationSeconds:4,trailing:true}]);
});

test("parses audio clipping, peak, RMS and integrated loudness",()=>{
 const metrics=parseAudioMetrics("Peak level dB: -0.4\nRMS level dB: -18.2\nNumber of samples clipped: 12\n I: -16.7 LUFS");
 assert.deepEqual(metrics,{clippedSamples:12,peakDbfs:-0.4,rmsDbfs:-18.2,integratedLufs:-16.7});
});
test("flags clipped samples and near-full-scale peaks without imposing a loudness target",()=>{
 const findings=buildAudioMetricFindings({clippedSamples:4,peakDbfs:-0.5,rmsDbfs:-18,integratedLufs:-16});
 assert.ok(findings.some(item=>item.code==="AUDIO_CLIPPING"));
 assert.ok(findings.some(item=>item.code==="AUDIO_PEAK_NEAR_FULL_SCALE"));
 assert.equal(findings.length,2);
});

test("records unsupported optional filters without disguising them as clean results",async()=>{
 const result=await runOptionalSignalCheck(async()=>{throw Object.assign(new Error("missing filter"),{code:"MEDIA_PROCESS_FAILED"});});
 assert.deepEqual(result,{status:"unavailable",reason:"MEDIA_PROCESS_FAILED"});
});
test("does not swallow cancellation during optional signal analysis",async()=>{
 const cancelled=Object.assign(new Error("cancelled"),{code:"MEDIA_CANCELLED"});
 await assert.rejects(()=>runOptionalSignalCheck(async()=>{throw cancelled;},{isCancelled:()=>true}),error=>error===cancelled);
});

test("parses freeze intervals and scene-change timestamps from FFmpeg diagnostics",()=>{
 const stderr="[freezedetect] freeze_start: 1.000\n[freezedetect] freeze_end: 4.500 | freeze_duration: 3.500\n[Parsed_showinfo] n: 1 pts: 90000 pts_time: 1.000\n[Parsed_showinfo] n: 2 pts: 270000 pts_time: 3.000";
 assert.deepEqual(parseFreezeEvents(stderr),[{startSeconds:1,endSeconds:4.5,durationSeconds:3.5}]);
 assert.deepEqual(parseSceneChangeTimes(stderr),[1,3]);
});
test("flags sustained freeze intervals for human review",()=>{
 const findings=buildMediaSignalFindings({freezes:[{startSeconds:2,endSeconds:5,durationSeconds:3}]});
 assert.ok(findings.some(item=>item.code==="FROZEN_VIDEO_INTERVAL"&&item.severity==="warning"));
});

test("derives bounded non-silence activity intervals from detected silence",()=>{
 const intervals=buildNonSilenceActivityIntervals({durationSeconds:10,silence:[{startSeconds:2,endSeconds:4},{startSeconds:6,endSeconds:8}],minActivitySeconds:.5,padSeconds:.1});
 assert.deepEqual(intervals,[
  {startSeconds:0,endSeconds:2.1,durationSeconds:2.1},
  {startSeconds:3.9,endSeconds:6.1,durationSeconds:2.2},
  {startSeconds:7.9,endSeconds:10,durationSeconds:2.1}
 ]);
});
test("merges overlapping silence, clips out-of-range events and ignores short active bursts",()=>{
 const intervals=buildNonSilenceActivityIntervals({durationSeconds:5,silence:[{startSeconds:-1,endSeconds:1},{startSeconds:.8,endSeconds:2},{startSeconds:4,endSeconds:8}],minActivitySeconds:.2,padSeconds:0});
 assert.deepEqual(intervals,[{startSeconds:2,endSeconds:4,durationSeconds:2}]);
});
test("activity analysis validates duration, silence intervals and tuning bounds",()=>{
 assert.throws(()=>buildNonSilenceActivityIntervals({durationSeconds:0}),/positive finite/);
 assert.throws(()=>buildNonSilenceActivityIntervals({durationSeconds:2,silence:[{startSeconds:2,endSeconds:1}]}),/ordered timestamps/);
 assert.throws(()=>buildNonSilenceActivityIntervals({durationSeconds:2,padSeconds:3}),/padding/);
});
