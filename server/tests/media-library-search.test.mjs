import test from "node:test";
import assert from "node:assert/strict";
import {rankMediaAssets} from "../../src/core/media-library-search.ts";
const assets=[
 {id:"a",name:"interview-final.mp4",mediaType:"video/mp4",projectId:"p1",createdAt:"2026-11-10",metadata:{description:"Workshop interview",transcript:{segments:[{start:12.4,end:13.2,text:"The solar panels power the workshop."}]},tags:["documentary","solar"]}},
 {id:"b",name:"b-roll.mp4",mediaType:"video/mp4",projectId:"p1",metadata:{visualDescription:"Aerial shot of Kampala streets",tags:["city"]}},
 {id:"c",name:"private.mp4",mediaType:"video/mp4",projectId:"p2",metadata:{transcriptText:"The solar workshop is open."}}
];
test("finds transcript phrases and returns exact source timecodes",()=>{const hits=rankMediaAssets(assets,"solar panels workshop");assert.equal(hits.length,1);assert.equal(hits[0].asset.id,"a");assert.equal(hits[0].field,"transcript");assert.equal(hits[0].timeSeconds,12.4);});
test("searches descriptive metadata and enforces project scoping",()=>{const hits=rankMediaAssets(assets,"Kampala streets",{projectId:"p1"});assert.equal(hits.length,1);assert.equal(hits[0].asset.id,"b");assert.equal(rankMediaAssets(assets,"solar workshop",{projectId:"p1"}).length,1);});
test("requires every query term and bounds result count",()=>{assert.deepEqual(rankMediaAssets(assets,"  "),[]);assert.equal(rankMediaAssets(assets,"solar",{limit:1}).length,1);assert.deepEqual(rankMediaAssets(assets,"solar unicorn"),[]);});
test("filters by media type and returns no cross-project matches",()=>{assert.deepEqual(rankMediaAssets(assets,"solar workshop",{projectId:"p1",mediaType:"audio/"}),[]);assert.deepEqual(rankMediaAssets(assets,"solar workshop",{projectId:"missing"}),[]);});
