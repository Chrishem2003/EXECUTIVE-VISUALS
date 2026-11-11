import test from "node:test";
import assert from "node:assert/strict";
import {parseBlackFrameEvents,parseSilenceEvents,buildMediaSignalFindings,parseAudioMetrics,buildAudioMetricFindings,parseFreezeEvents,parseSceneChangeTimes,parseTemporalLumaSamples,buildTemporalLumaFindings,buildTemporalColorFindings,runOptionalSignalCheck} from "../media-signal-analysis.mjs";

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


test("parses frame-average luma samples from FFmpeg signalstats metadata",()=>{
 const stderr="[Parsed_metadata_2] frame:0 pts:0 pts_time:0.000\\n[Parsed_metadata_2] lavfi.signalstats.YAVG=48.5\\n[Parsed_metadata_2] frame:1 pts:45000 pts_time:0.500\\n[Parsed_metadata_2] lavfi.signalstats.YAVG=52.0";
 assert.deepEqual(parseTemporalLumaSamples(stderr),[
  {frame:0,pts:0,timeSeconds:0,meanLuma:48.5},
  {frame:1,pts:45000,timeSeconds:0.5,meanLuma:52}
 ]);
});

test("flags repeated alternating brightness changes but not stable scenes",()=>{
 const samples=[40,95,42,98,41].map((meanLuma,index)=>({frame:index,timeSeconds:index*0.5,meanLuma}));
 const findings=buildTemporalLumaFindings({samples});
 assert.equal(findings.length,1);
 assert.equal(findings[0].code,"ALTERNATING_LUMINANCE_INSTABILITY");
 assert.equal(findings[0].transitions,4);
 assert.equal(buildTemporalLumaFindings({samples:[40,43,41,44,42].map((meanLuma,index)=>({frame:index,timeSeconds:index*0.5,meanLuma}))}).length,0);
});

test("excludes brightness jumps adjacent to detected scene cuts",()=>{
 const samples=[40,45,140,145].map((meanLuma,index)=>({frame:index,timeSeconds:index*0.5,meanLuma}));
 assert.equal(buildTemporalLumaFindings({samples,sceneChanges:[0.75]}).length,0);
});

test("flags a single abrupt brightness change for human review",()=>{
 const samples=[30,35,120,125].map((meanLuma,index)=>({frame:index,timeSeconds:index*0.5,meanLuma}));
 const findings=buildTemporalLumaFindings({samples});
 assert.ok(findings.some(item=>item.code==="ABRUPT_LUMINANCE_CHANGE"));
});


test("parses frame-average luma, saturation and chroma metadata from FFmpeg",()=>{
 const stderr="[Parsed_metadata] frame:0 pts:0 pts_time:0.000\\n[Parsed_metadata] lavfi.signalstats.YAVG=40\\n[Parsed_metadata] lavfi.signalstats.SATAVG=50\\n[Parsed_metadata] lavfi.signalstats.UAVG=128\\n[Parsed_metadata] lavfi.signalstats.VAVG=129\\n[Parsed_metadata] frame:1 pts:11250 pts_time:0.125\\n[Parsed_metadata] lavfi.signalstats.YAVG=42\\n[Parsed_metadata] lavfi.signalstats.SATAVG=52\\n[Parsed_metadata] lavfi.signalstats.UAVG=130\\n[Parsed_metadata] lavfi.signalstats.VAVG=131";
 const samples=parseTemporalLumaSamples(stderr);
 assert.equal(samples.length,2);
 assert.deepEqual({luma:samples[0].meanLuma,saturation:samples[0].meanSaturation,u:samples[0].meanU,v:samples[0].meanV},{luma:40,saturation:50,u:128,v:129});
 assert.equal(samples[1].meanSaturation,52);
});

test("flags repeated alternating global saturation changes for review",()=>{
 const samples=[40,70,41,72,42].map((meanSaturation,index)=>({timeSeconds:index*0.125,meanLuma:80,meanSaturation,meanU:128,meanV:128}));
 const findings=buildTemporalColorFindings({samples});
 assert.equal(findings.length,1);
 assert.equal(findings[0].code,"ALTERNATING_SATURATION_INSTABILITY");
 assert.equal(findings[0].transitions,4);
});

test("flags alternating chroma-vector reversals but excludes scene-cut neighborhoods",()=>{
 const samples=[128,158,128,158,128].map((meanU,index)=>({timeSeconds:index*0.125,meanLuma:80,meanSaturation:60,meanU,meanV:128}));
 const findings=buildTemporalColorFindings({samples});
 assert.ok(findings.some(item=>item.code==="ALTERNATING_CHROMA_INSTABILITY"));
 assert.equal(buildTemporalColorFindings({samples,sceneChanges:[0.25]}).length,0);
});
