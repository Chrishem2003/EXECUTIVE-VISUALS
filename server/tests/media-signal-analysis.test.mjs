import test from "node:test";
import assert from "node:assert/strict";
import {parseBlackFrameEvents,parseSilenceEvents,buildMediaSignalFindings,parseAudioMetrics,buildAudioMetricFindings} from "../media-signal-analysis.mjs";

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
