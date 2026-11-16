import test from "node:test";
import assert from "node:assert/strict";
import {buildAudioMasterAnalysisArgs,buildAudioMasterRenderArgs,parseAudioMasterMeasurement} from "../media.mjs";

const sourcePath="/private/source.wav",outputPath="/private/mastered.wav";
const stderr=`ffmpeg loudnorm stats:
{
 "input_i" : "-20.15",
 "input_tp" : "-3.22",
 "input_lra" : "4.10",
 "input_thresh" : "-30.25",
 "output_i" : "-16.10",
 "output_tp" : "-1.50",
 "output_lra" : "3.20",
 "output_thresh" : "-26.20",
 "normalization_type" : "linear",
 "target_offset" : "0.10"
}`;

test("audio mastering analysis uses EBU R128 loudnorm measurement",()=>{
 const args=buildAudioMasterAnalysisArgs({sourcePath,input:{targetLufs:-16,targetLra:11,truePeakDbtp:-1.5}});
 assert.ok(args.includes("0:a:0"));
 assert.equal(args[args.indexOf("-af")+1],"loudnorm=I=-16.0:LRA=11.0:TP=-1.5:print_format=json");
 assert.deepEqual(args.slice(-3),["-f","null","-"]);
});

test("loudnorm measurements parse into finite, explicit evidence",()=>{
 assert.deepEqual(parseAudioMasterMeasurement(stderr),{
  integratedLufs:-20.15,truePeakDbtp:-3.22,loudnessRangeLu:4.1,thresholdLufs:-30.25,targetOffsetDb:0.1
 });
});

test("audio mastering render uses measured two-pass linear normalization and 24-bit PCM",()=>{
 const measurement=parseAudioMasterMeasurement(stderr);
 const args=buildAudioMasterRenderArgs({sourcePath,outputPath,input:{targetLufs:-16,targetLra:11,truePeakDbtp:-1.5},measurement});
 const filter=args[args.indexOf("-af")+1];
 assert.match(filter,/measured_I=-20.150/);
 assert.match(filter,/measured_TP=-3.220/);
 assert.match(filter,/measured_LRA=4.100/);
 assert.match(filter,/measured_thresh=-30.250/);
 assert.match(filter,/linear=true/);
 assert.match(filter,/aresample=48000/);
 assert.ok(args.includes("pcm_s24le"));
 assert.ok(args.includes("48000"));
 assert.equal(args.at(-1),outputPath);
});

test("audio mastering rejects invalid targets, missing metrics and silent sources",()=>{
 assert.throws(()=>buildAudioMasterAnalysisArgs({sourcePath,input:{targetLufs:-5}}),e=>e.code==="INVALID_MEDIA_OPTIONS");
 assert.throws(()=>buildAudioMasterAnalysisArgs({sourcePath,input:{targetLra:30}}),e=>e.code==="INVALID_MEDIA_OPTIONS");
 assert.throws(()=>buildAudioMasterAnalysisArgs({sourcePath,input:{truePeakDbtp:0}}),e=>e.code==="INVALID_MEDIA_OPTIONS");
 assert.throws(()=>parseAudioMasterMeasurement("no loudness json"),e=>e.code==="AUDIO_MASTER_MEASUREMENT_INVALID");
 assert.throws(()=>parseAudioMasterMeasurement(stderr.replace('"input_i" : "-20.15"','"input_i" : "-inf"')),e=>e.code==="AUDIO_MASTER_MEASUREMENT_INVALID");
 assert.throws(()=>buildAudioMasterRenderArgs({sourcePath,outputPath,input:{},measurement:null}),e=>e.code==="INVALID_MEDIA_OPTIONS");
});
