import test from "node:test";
import assert from "node:assert/strict";
import {parseBlackFrameEvents,parseSilenceEvents,buildMediaSignalFindings,parseAudioMetrics,buildAudioMetricFindings,parseFreezeEvents,parseSceneChangeTimes,runOptionalSignalCheck,parseVideoLumaSamples,parseSceneCutTimes,buildTemporalLumaFindings} from "../media-signal-analysis.mjs";

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
 const metrics=parseAudioMetrics("Peak level dB: -0.4\nRMS level dB: -18.2\nNumber of samples clipped: 12\n I: -16.7 LUFS\n True peak: -0.6 dBFS");
 assert.deepEqual(metrics,{clippedSamples:12,peakDbfs:-0.4,truePeakDbtp:-0.6,rmsDbfs:-18.2,integratedLufs:-16.7});
});
test("flags clipped samples and near-full-scale peaks without imposing a loudness target",()=>{
 const findings=buildAudioMetricFindings({clippedSamples:4,peakDbfs:-0.5,truePeakDbtp:-0.4,rmsDbfs:-18,integratedLufs:-16});
 assert.ok(findings.some(item=>item.code==="AUDIO_CLIPPING"));
 assert.ok(findings.some(item=>item.code==="AUDIO_PEAK_NEAR_FULL_SCALE"));
 assert.ok(findings.some(item=>item.code==="AUDIO_TRUE_PEAK_NEAR_LIMIT"));
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


test("parses bounded per-frame FFmpeg signalstats luminance samples",()=>{
 const samples=parseVideoLumaSamples("frame:0 pts:0 pts_time:0.000\nlavfi.signalstats.YAVG=42.5\nframe:1 pts:1000 pts_time:0.040\nlavfi.signalstats.YAVG=73.25\nframe:2 pts:2000 pts_time:0.080\nlavfi.signalstats.YAVG=300");
 assert.deepEqual(samples,[{frame:0,timeSeconds:0,meanLuma:42.5},{frame:1,timeSeconds:0.04,meanLuma:73.25}]);
});
test("flags abrupt luminance changes away from scene cuts",()=>{
 const samples=[{timeSeconds:0,meanLuma:40},{timeSeconds:.04,meanLuma:82},{timeSeconds:.08,meanLuma:85},{timeSeconds:.12,meanLuma:88}];
 const findings=buildTemporalLumaFindings({lumaSamples:samples,minimumDelta:30});
 assert.equal(findings.length,1);
 assert.equal(findings[0].code,"ABRUPT_LUMA_CHANGE");
});
test("suppresses scene-cut transitions and identifies alternating luminance flicker",()=>{
 const cut=buildTemporalLumaFindings({lumaSamples:[{timeSeconds:0,meanLuma:20},{timeSeconds:.04,meanLuma:100}],sceneChanges:[.04]});
 assert.equal(cut.length,0);
 const flicker=buildTemporalLumaFindings({lumaSamples:[{timeSeconds:0,meanLuma:40},{timeSeconds:.04,meanLuma:80},{timeSeconds:.08,meanLuma:42},{timeSeconds:.12,meanLuma:82},{timeSeconds:.16,meanLuma:40}],minimumDelta:80,alternatingMinimumDelta:18,alternatingWindow:4});
 assert.ok(flicker.some(item=>item.code==="TEMPORAL_LUMA_FLICKER"));
});


test("parses only FFmpeg frames whose scene-detection score crosses the cut threshold",()=>{
 const output="frame:0 pts:0 pts_time:0.000\nlavfi.signalstats.YAVG=42\nlavfi.scd.score=2\nframe:1 pts:1000 pts_time:0.500\nlavfi.signalstats.YAVG=120\nlavfi.scd.score=18.5\nframe:2 pts:2000 pts_time:1.000\nlavfi.signalstats.YAVG=80\nlavfi.scd.score=8";
 assert.deepEqual(parseSceneCutTimes(output),[0.5]);
});
