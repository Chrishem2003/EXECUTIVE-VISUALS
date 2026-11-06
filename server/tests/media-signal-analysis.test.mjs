import test from "node:test";
import assert from "node:assert/strict";
import {parseBlackFrameEvents,parseSilenceEvents,buildMediaSignalFindings,parseAudioMetrics,buildAudioMetricFindings,parseFreezeEvents,parseSceneChangeTimes,runOptionalSignalCheck,buildLoudnormAnalysisFilter,parseLoudnormMeasurements,buildLoudnormNormalizationFilter} from "../media-signal-analysis.mjs";

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
 assert.deepEqual(metrics,{clippedSamples:12,peakDbfs:-0.4,truePeakDbfs:null,rmsDbfs:-18.2,integratedLufs:-16.7});
});
test("parses FFmpeg EBU R128 true-peak summary separately from sample peak",()=>{
 const metrics=parseAudioMetrics("Peak level dB: -1.2\nRMS level dB: -18.2\n I: -16.7 LUFS\n\n True peak:\n Peak: -0.4 dBFS");
 assert.equal(metrics.peakDbfs,-1.2);
 assert.equal(metrics.truePeakDbfs,-0.4);
 const silence=parseAudioMetrics("True peak:\n Peak: -inf dBFS");
 assert.equal(silence.truePeakDbfs,null);
});
test("flags true-peak headroom independently from sample-peak headroom",()=>{
 const findings=buildAudioMetricFindings({peakDbfs:-2.5,truePeakDbfs:-0.4});
 assert.deepEqual(findings.map(item=>item.code),["AUDIO_TRUE_PEAK_NEAR_FULL_SCALE"]);
});
test("flags clipped samples and near-full-scale peaks without imposing a loudness target",()=>{
 const findings=buildAudioMetricFindings({clippedSamples:4,peakDbfs:-0.5,rmsDbfs:-18,integratedLufs:-16});
 assert.ok(findings.some(item=>item.code==="AUDIO_CLIPPING"));
 assert.ok(findings.some(item=>item.code==="AUDIO_PEAK_NEAR_FULL_SCALE"));
 assert.equal(findings.length,2);
});


const loudnormFixture=JSON.stringify({input_i:"-20.0",input_tp:"-2.1",input_lra:"4.5",input_thresh:"-30.0",output_i:"-16.0",output_tp:"-1.5",output_lra:"4.5",output_thresh:"-26.0",normalization_type:"linear",target_offset:"4.0"});
test("builds a bounded first-pass EBU R128 loudness analysis filter",()=>{
 assert.equal(buildLoudnormAnalysisFilter(), "loudnorm=I=-16:LRA=11:TP=-1.5:dual_mono=false:print_format=json");
 assert.equal(buildLoudnormAnalysisFilter({integratedLufs:-23,loudnessRange:7,truePeakDbtp:-2,dualMono:true}),"loudnorm=I=-23:LRA=7:TP=-2:dual_mono=true:print_format=json");
 assert.throws(()=>buildLoudnormAnalysisFilter({integratedLufs:1}),/integratedLufs/);
 assert.throws(()=>buildLoudnormAnalysisFilter({truePeakDbtp:-10}),/truePeakDbtp/);
});
test("parses FFmpeg loudnorm first-pass JSON measurements",()=>{
 assert.deepEqual(parseLoudnormMeasurements("noise before\n"+loudnormFixture+"\nnoise after"),{integratedLufs:-20,truePeakDbtp:-2.1,loudnessRange:4.5,thresholdDb:-30,offsetDb:4});
 assert.equal(parseLoudnormMeasurements("no valid JSON"),null);
 assert.equal(parseLoudnormMeasurements(JSON.stringify({input_i:"-inf",input_tp:"-2",input_lra:"4",input_thresh:"-30",target_offset:"0"})),null);
});
test("builds measured two-pass normalization only from complete bounded measurements",()=>{
 const measurements={integratedLufs:-20,truePeakDbtp:-2.1,loudnessRange:4.5,thresholdDb:-30,offsetDb:4};
 assert.equal(buildLoudnormNormalizationFilter({measurements}),"loudnorm=I=-16:LRA=11:TP=-1.5:measured_I=-20:measured_TP=-2.1:measured_LRA=4.5:measured_thresh=-30:offset=4:linear=true:dual_mono=false:print_format=json");
 assert.throws(()=>buildLoudnormNormalizationFilter(),/first-pass/);
 assert.throws(()=>buildLoudnormNormalizationFilter({measurements:{...measurements,truePeakDbtp:100}}),/truePeakDbtp/);
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
