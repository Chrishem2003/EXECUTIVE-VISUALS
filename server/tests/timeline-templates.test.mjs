import test from "node:test";
import assert from "node:assert/strict";
import {createTimeline} from "../../src/core/timeline.ts";
import {applyTimelineTemplate,listTimelineTemplates} from "../../src/core/timeline-templates.ts";

test("lists usable editorial templates with expected formats",()=>{
 const templates=listTimelineTemplates();
 assert.ok(templates.length>=4);
 assert.deepEqual([templates[0].width,templates[0].height,templates[0].fps],[1080,1920,30]);
});
test("social short template creates editable tracks and structured review markers",()=>{
 const base=createTimeline("project","sequence","Campaign",{numerator:24,denominator:1});
 const result=applyTimelineTemplate(base,"social-short");
 assert.equal(result.width,1080);assert.equal(result.height,1920);
 assert.equal(result.frameRate.numerator,30);
 assert.equal(result.tracks.length,5);
 assert.equal(result.markers[0].name,"Opening hook");
 assert.equal(result.markers[0].note,"Lead with the strongest visual or question.");
 assert.equal(result.metadata?.templateId,"social-short");
 assert.equal(base.tracks.length,0,"template application does not mutate the original timeline");
});
test("rejects unknown template IDs",()=>{
 const base=createTimeline("project","sequence");
 assert.throws(()=>applyTimelineTemplate(base,"unknown"),/Unknown timeline template/);
});

test("all starter templates remain compatible with the single-primary-video cloud renderer",()=>{
 const base=createTimeline("project","sequence");
 for(const template of listTimelineTemplates()){
  const result=applyTimelineTemplate(base,template.id);
  assert.equal(result.tracks.filter(track=>track.kind==="video").length,1,template.id+" must have one primary video track");
  assert.ok(result.tracks.some(track=>track.kind==="audio"),template.id+" must include audio");
  assert.ok(result.tracks.some(track=>track.kind==="caption"),template.id+" must include captions");
 }
});
