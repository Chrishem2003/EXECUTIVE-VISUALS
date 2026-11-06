import test from "node:test";
import assert from "node:assert/strict";
import { filterReviewsByTimelineRevision } from "../../src/core/review-version.ts";
const timelines=[{id:"timeline-a",revision:4},{id:"timeline-b",revision:2}];
const reviews=[
 {id:"a-current",timelineId:"timeline-a",timelineRevision:4},
 {id:"a-old",timelineId:"timeline-a",timelineRevision:2},
 {id:"b-current",timelineId:"timeline-b",timelineRevision:2},
 {id:"unlinked",timelineId:null,timelineRevision:null},
 {id:"orphaned",timelineId:"missing",timelineRevision:1}
];
test("all scope preserves every review",()=>{
 assert.deepEqual(filterReviewsByTimelineRevision(reviews,timelines,"all"),reviews);
});
test("current scope matches each timeline's latest revision",()=>{
 assert.deepEqual(filterReviewsByTimelineRevision(reviews,timelines,"current").map(x=>x.id),["a-current","b-current"]);
});
test("previous scope includes only earlier known revisions",()=>{
 assert.deepEqual(filterReviewsByTimelineRevision(reviews,timelines,"previous").map(x=>x.id),["a-old"]);
});
test("unlinked scope includes only project or asset feedback without timeline anchors",()=>{
 assert.deepEqual(filterReviewsByTimelineRevision(reviews,timelines,"unlinked").map(x=>x.id),["unlinked"]);
});
test("missing timeline records are excluded from revision-specific scopes",()=>{
 assert.deepEqual(filterReviewsByTimelineRevision(reviews,timelines,"current").some(x=>x.id==="orphaned"),false);
 assert.deepEqual(filterReviewsByTimelineRevision(reviews,timelines,"previous").some(x=>x.id==="orphaned"),false);
});
