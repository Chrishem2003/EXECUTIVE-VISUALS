import test from "node:test";
import assert from "node:assert/strict";
import { createTimeline,addTrack,addClip,rational } from "../../src/core/timeline.ts";
import { assessCaptionEvidence } from "../../src/core/caption-evidence.ts";
function timeline(){let t=createTimeline("p","t","Captions");t=addTrack(t,{id:"c",name:"Captions",kind:"caption",enabled:true,locked:false,clips:[]});return addClip(t,"c",{id:"clip",assetId:"vtt",name:"Captions",sourceRange:{start:rational(0,24),duration:rational(120,24)},timelineStart:rational(0,24),duration:rational(120,24),enabled:true});}
const good={id:"vtt",name:"captions.vtt",mediaType:"text/vtt",metadata:{captionValidation:{status:"passed",cueCount:3,findings:[]}}};
test("missing caption track requires review rather than passing",()=>assert.equal(assessCaptionEvidence(null,[]).status,"review"));
test("missing assets and unsupported caption formats block",()=>{assert.equal(assessCaptionEvidence(timeline(),[]).status,"blocked");assert.equal(assessCaptionEvidence(timeline(),[{id:"vtt",name:"captions.srt",mediaType:"text/plain"}]).status,"blocked");});
test("missing cue-level report and supported SRT remain not-run",()=>{assert.equal(assessCaptionEvidence(timeline(),[{id:"vtt",name:"captions.vtt",mediaType:"text/vtt",metadata:{}}]).status,"not_run");const srt=assessCaptionEvidence(timeline(),[{id:"vtt",name:"captions.srt",mediaType:"text/plain",metadata:{}}]);assert.equal(srt.status,"not_run");assert.equal(srt.findings[0].code,"CAPTION_SRT_VALIDATION_NOT_RUN");});
test("validated WebVTT passes",()=>assert.equal(assessCaptionEvidence(timeline(),[good]).status,"passed"));
test("caption readability warnings remain review",()=>{const r=assessCaptionEvidence(timeline(),[{...good,metadata:{captionValidation:{status:"review",findings:[{code:"CAPTION_READING_SPEED_HIGH",severity:"warning",detail:"Too fast."}]}}}]);assert.equal(r.status,"review");assert.ok(r.findings.some(x=>x.code==="CAPTION_READING_SPEED_HIGH"));});
test("blocked WebVTT report blocks readiness",()=>assert.equal(assessCaptionEvidence(timeline(),[{...good,metadata:{captionValidation:{status:"blocked",findings:[]}}}]).status,"blocked"));
