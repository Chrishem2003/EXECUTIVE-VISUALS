import test from "node:test";
import assert from "node:assert/strict";
import {buildClipFadeFilters} from "../timeline-transitions.mjs";

test("builds bounded video fade-in and fade-out filters",()=>{
 assert.deepEqual(buildClipFadeFilters({metadata:{fadeInSeconds:0.5,fadeOutSeconds:1}},4,"video"),[
  "fade=t=in:st=0:d=0.500000","fade=t=out:st=3.000000:d=1.000000"
 ]);
});
test("builds matching audio fades and clamps them to clip duration",()=>{
 assert.deepEqual(buildClipFadeFilters({metadata:{fadeInSeconds:9,fadeOutSeconds:2}},3,"audio"),[
  "afade=t=in:st=0:d=3.000000","afade=t=out:st=1.000000:d=2.000000"
 ]);
});
test("ignores invalid fade metadata and rejects unsupported media kinds",()=>{
 assert.deepEqual(buildClipFadeFilters({metadata:{fadeInSeconds:-2,fadeOutSeconds:"bad"}},2,"video"),[]);
 assert.throws(()=>buildClipFadeFilters({},2,"text"),/Unsupported clip fade media kind/);
});
test("returns no filters for invalid clip duration",()=>{
 assert.deepEqual(buildClipFadeFilters({metadata:{fadeInSeconds:1}},0,"video"),[]);
});
