import test from "node:test";
import assert from "node:assert/strict";
import { validateWebVtt } from "../caption-validation.mjs";
const vtt=(cues)=>"WEBVTT\n\n"+cues.map(([a,b,t])=>a+" --> "+b+"\n"+t).join("\n\n")+"\n";
test("valid WebVTT with readable timed cues passes",()=>{const r=validateWebVtt(vtt([["00:00:00.000","00:00:02.000","Opening line"],["00:00:02.000","00:00:04.000","A second line"]]),{durationSeconds:5});assert.equal(r.status,"passed");assert.equal(r.cueCount,2);});
test("rejects missing header, malformed timing, empty cues and oversized files",()=>{assert.equal(validateWebVtt("not vtt").status,"blocked");assert.equal(validateWebVtt("WEBVTT\n\nnot a cue\n").status,"blocked");assert.equal(validateWebVtt("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n\n").status,"blocked");assert.equal(validateWebVtt("WEBVTT\n"+"x".repeat(2*1024*1024)).status,"blocked");});
test("detects overlap, reading speed, long lines and excessive cue duration",()=>{const r=validateWebVtt(vtt([["00:00:00.000","00:00:08.000","x".repeat(50)],["00:00:07.000","00:00:08.000","y".repeat(50)]]));assert.equal(r.status,"review");assert.ok(r.findings.some(x=>x.code==="CAPTION_CUE_OVERLAP"));assert.ok(r.findings.some(x=>x.code==="CAPTION_READING_SPEED_HIGH"));assert.ok(r.findings.some(x=>x.code==="CAPTION_LINE_TOO_LONG"));assert.ok(r.findings.some(x=>x.code==="CAPTION_CUE_TOO_LONG"));});
test("blocks cues that extend beyond the supplied media duration",()=>{const r=validateWebVtt(vtt([["00:00:03.000","00:00:05.000","Too late"]]),{durationSeconds:4});assert.equal(r.status,"blocked");assert.ok(r.findings.some(x=>x.code==="CAPTION_OUT_OF_RANGE"));});
test("accepts NOTE blocks and cue identifiers",()=>{const r=validateWebVtt("WEBVTT\n\nNOTE generated file\nignored\n\ncue-1\n00:00:00.000 --> 00:00:02.000\nHello\n");assert.equal(r.status,"passed");assert.equal(r.cueCount,1);});

import { validateSrt } from "../caption-validation.mjs";
test("validates SRT cue timing, readability and media bounds",()=>{const srt="1\n00:00:00,000 --> 00:00:02,000\nOpening line\n\n2\n00:00:02,000 --> 00:00:04,000\nA second line\n";const r=validateSrt(srt,{durationSeconds:5});assert.equal(r.status,"passed");assert.equal(r.format,"srt");assert.equal(r.cueCount,2);});
test("blocks malformed SRT timing and cues outside media duration",()=>{assert.equal(validateSrt("1\nwrong timing\nNo timing").status,"blocked");const r=validateSrt("1\n00:00:03,000 --> 00:00:05,000\nToo late",{durationSeconds:4});assert.equal(r.status,"blocked");assert.ok(r.findings.some(x=>x.code==="CAPTION_OUT_OF_RANGE"));});
test("flags SRT overlap and reading-speed warnings",()=>{const r=validateSrt("1\n00:00:00,000 --> 00:00:08,000\n"+"x".repeat(50)+"\n\n2\n00:00:07,000 --> 00:00:08,000\n"+"y".repeat(50));assert.equal(r.status,"review");assert.ok(r.findings.some(x=>x.code==="CAPTION_CUE_OVERLAP"));});

test("accepts a UTF-8 BOM before the WebVTT header",()=>{
 const r=validateWebVtt("\uFEFF"+vtt([["00:00:00.000","00:00:02.000","BOM-prefixed captions"]]));
 assert.equal(r.status,"passed");
 assert.equal(r.cueCount,1);
});

test("enforces the configured cue limit without accepting an extra cue",()=>{
 const content=vtt([
  ["00:00:00.000","00:00:01.000","One"],
  ["00:00:01.000","00:00:02.000","Two"],
  ["00:00:02.000","00:00:03.000","Three"]
 ]);
 const report=validateWebVtt(content,{maxCues:2});
 assert.equal(report.cueCount,2);
 assert.equal(report.status,"blocked");
 assert.ok(report.findings.some(item=>item.code==="CAPTION_CUE_LIMIT_EXCEEDED"));
});
