import test from "node:test";
import assert from "node:assert/strict";
import { appendCreativeDecision, readCreativeDecisionHistory } from "../../src/core/creative-decision-ledger.ts";
import { createTimeline, addTrack, addClip, rational } from "../../src/core/timeline.ts";

const trace=(storyBeat,purpose="Show the key idea")=>({storyBeat,purpose,audiencePromise:"A useful reveal",proofReference:"",decisionNote:""});
function clipWithHistory(history){const timeline=createTimeline("p","t");const withTrack=addTrack(timeline,{id:"v",name:"Video",kind:"video",enabled:true,locked:false,clips:[]});const withClip=addClip(withTrack,"v",{id:"c",assetId:"a",name:"Clip",sourceRange:{start:rational(0,24),duration:rational(24,24)},timelineStart:rational(0,24),duration:rational(24,24),enabled:true,metadata:{creativeTraceHistory:history}});return withClip.tracks[0].clips[0];}
test("first annotation creates an immutable decision record",()=>{
 const records=appendCreativeDecision([],null,trace("Opening hook"),"d1","2026-11-02T10:00:00.000Z");
 assert.equal(records.length,1);assert.equal(records[0].sequence,1);assert.equal(records[0].summary,"Updated story beat, shot purpose, audience promise");
 assert.equal(records[0].before,null);assert.equal(records[0].after.storyBeat,"Opening hook");
});
test("changed creative direction appends a new revision without rewriting the first",()=>{
 const first=appendCreativeDecision([],null,trace("Opening hook"),"d1","2026-11-02T10:00:00Z");
 const second=appendCreativeDecision(first,trace("Opening hook"),trace("Proof"),"d2","2026-11-02T10:01:00Z");
 assert.equal(second.length,2);assert.equal(second[1].sequence,2);assert.equal(second[1].summary,"Updated story beat");
 assert.equal(second[0].after.storyBeat,"Opening hook");assert.equal(second[1].before.storyBeat,"Opening hook");
});
test("no-op saves do not create noise in the decision history",()=>{
 const first=appendCreativeDecision([],null,trace("Opening hook"),"d1","2026-11-02T10:00:00Z");
 const second=appendCreativeDecision(first,trace("Opening hook"),trace("Opening hook"),"d2","2026-11-02T10:01:00Z");
 assert.equal(second.length,1);assert.equal(second[0].id,"d1");
});
test("duplicate IDs and invalid timestamps are rejected",()=>{
 const first=appendCreativeDecision([],null,trace("Opening hook"),"d1","2026-11-02T10:00:00Z");
 assert.throws(()=>appendCreativeDecision(first,trace("Opening hook"),trace("Proof"),"d1","2026-11-02T10:01:00Z"),/unique/);
 assert.throws(()=>appendCreativeDecision([],null,trace("Opening hook"),"d2","bad-date"),/timestamp/);
});
test("history is capped and malformed persisted entries are ignored",()=>{
 let records=[];
 for(let i=0;i<105;i++)records=appendCreativeDecision(records,i?trace("Beat "+(i-1)):null,trace("Beat "+i),"d"+i,"2026-11-02T10:00:00Z");
 assert.equal(records.length,100);assert.equal(records[0].sequence,6);assert.equal(records.at(-1).sequence,105);
 const clip=clipWithHistory([...records,{id:"bad",sequence:"x",recordedAt:"not-a-date"}]);
 assert.equal(readCreativeDecisionHistory(clip).length,100);
});
