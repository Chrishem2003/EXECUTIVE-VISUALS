import test from "node:test";
import assert from "node:assert/strict";
import { convertCaptionFormat,buildCaptionPackage } from "../caption-packaging.mjs";

const srt="1\n00:00:01,250 --> 00:00:03,500\nHello, world!\n\n2\n00:00:04,000 --> 00:00:06,000\nПривіт 🌍\n";
const vtt="WEBVTT\n\nintro\n00:00:01.250 --> 00:00:03.500\nHello, world!\n\nsecond\n00:00:04.000 --> 00:00:06.000\nПривіт 🌍\n";

test("converts valid UTF-8 SRT to WebVTT without losing cue text or timing",()=>{
 const result=convertCaptionFormat(srt,{from:"srt",to:"webvtt",durationSeconds:8});
 assert.equal(result.cueCount,2);assert.equal(result.outputValidation.status,"passed");
 assert.match(result.content,/WEBVTT/);assert.match(result.content,/00:00:01\.250 --> 00:00:03\.500/);
 assert.match(result.content,/Привіт 🌍/);
});
test("converts WebVTT to SRT with canonical cue numbering and comma milliseconds",()=>{
 const result=convertCaptionFormat(vtt,{from:"webvtt",to:"srt",durationSeconds:8});
 assert.equal(result.cueCount,2);assert.equal(result.outputValidation.status,"passed");
 assert.match(result.content,/1\n00:00:01,250 --> 00:00:03,500/);assert.match(result.content,/2\n00:00:04,000 --> 00:00:06,000/);
 assert.match(result.content,/Привіт 🌍/);
});
test("refuses invalid or cue-loss conversions and unsupported formats",()=>{
 assert.throws(()=>convertCaptionFormat("bad",{from:"srt",to:"webvtt"}),error=>error.code==="CAPTION_SOURCE_INVALID");
 assert.throws(()=>convertCaptionFormat(srt,{from:"srt",to:"ass"}),error=>error.code==="CAPTION_FORMAT_UNSUPPORTED");
});
test("builds a deterministic multilingual manifest and one file per language",()=>{
 const result=buildCaptionPackage({tracks:[{language:"en",format:"srt",content:srt},{language:"uk-UA",format:"webvtt",content:vtt}],defaultFormat:"webvtt",durationSeconds:8});
 assert.equal(result.schemaVersion,1);assert.equal(result.manifest.schema,"executive-visuals.caption-package.v1");
 assert.equal(result.manifest.trackCount,2);assert.equal(result.files.length,2);
 assert.deepEqual(result.files.map(file=>file.filename),["captions-en.vtt","captions-uk-ua.vtt"]);
 assert.equal(result.manifest.tracks[0].cueCount,2);
});
test("rejects duplicate or invalid language tags and excessive track counts",()=>{
 assert.throws(()=>buildCaptionPackage({tracks:[{language:"en",content:vtt},{language:"EN",content:vtt}]}),error=>error.code==="CAPTION_LANGUAGE_DUPLICATE");
 assert.throws(()=>buildCaptionPackage({tracks:[{language:"../../private",content:vtt}]}),error=>error.code==="CAPTION_LANGUAGE_INVALID");
 assert.throws(()=>buildCaptionPackage({tracks:Array.from({length:33},(_,i)=>({language:"x-"+String(i).padStart(2,"0"),content:vtt}))}),error=>error.code==="CAPTION_TRACK_LIMIT");
});
