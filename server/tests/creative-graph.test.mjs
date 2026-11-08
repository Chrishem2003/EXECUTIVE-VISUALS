import test from "node:test";
import assert from "node:assert/strict";
import { buildCreativeGraph, analyzeCreativeImpact } from "../../src/core/creative-graph.ts";

const fixture={
 project:{id:"project-1",name:"Launch film",brief:"Show how the product changes the daily workflow."},
 creativeDNA:{creativePromise:"Make complex work feel simple.",proofAndTrustChecks:["Separate fact from opinion","Proof candidate supplied: A recorded before/after test"],storyBeats:["OPEN","PROVE","PAY OFF"]},
 characters:[{id:"character-1",name:"Maya",description:"Presenter",referenceAssetIds:["asset-1"]}],
 shots:[],
 seriesPlans:[{id:"series-1",title:"Launch series",storyBible:{entries:[{id:"character-2",kind:"character",name:"Engineer",description:"Technical expert",referenceAssetIds:[]}]},seasons:[{episodes:[{id:"episode-1",title:"Episode 1",scenes:[{id:"scene-1",title:"The problem",purpose:"Establish friction",storyBibleEntryIds:["character-2"],shots:[{id:"shot-1",prompt:"Maya demonstrates the old workflow",characterIds:["character-1"],storyBibleEntryIds:["character-2"],proofReference:"recording-1",referenceAssetIds:["asset-1"]}]}]}]}]}],
 timelines:[{id:"timeline-1",name:"Episode edit",timeline:{markers:[{id:"scene-1",name:"The problem"},{id:"shot-1",name:"Shot 1"}],tracks:[{clips:[{id:"clip-1",assetId:"asset-1",name:"Opening shot"}]}]}}],
 assets:[{id:"asset-1",name:"Approved presenter reference",mediaType:"image/jpeg",sha256:"a".repeat(64)}],
 evidenceRecords:[{id:"evidence-1",projectId:"project-1",sourceAssetId:"asset-1",sourceSha256:"a".repeat(64),target:{type:"shot",id:"shot-1"},kind:"performance_observation",claim:"Presenter demonstrates the approved workflow.",status:"verified"},{id:"evidence-2",projectId:"project-1",sourceAssetId:"asset-1",sourceSha256:"a".repeat(64),target:{type:"scene",id:"scene-1"},kind:"context_reference",claim:"Scene context is visible in the recorded source.",status:"submitted"}]
};

test("creative graph links explicit brief, intent, evidence, characters, scenes, shots, assets and timeline dependencies",()=>{
 const graph=buildCreativeGraph(fixture);
 const has=(from,to,relation)=>graph.edges.some(edge=>edge.from===from&&edge.to===to&&edge.relation===relation);
 assert.ok(has("project:project-1","brief:project-1","contains"));
 assert.ok(has("brief:project-1","intent:project-1","guides"));
 assert.ok(has("character:character-1","shot:shot-1","features"));
 assert.ok(has("character:character-2","scene:scene-1","features"));
 assert.ok(has("character:character-2","shot:shot-1","features"));
 assert.ok(has("scene:scene-1","shot:shot-1","contains"));
 assert.ok(has("shot:shot-1","timeline:timeline-1","appears_in"));
 assert.ok(has("asset:asset-1","clip:clip-1","uses"));
 assert.ok(has("clip:clip-1","timeline:timeline-1","appears_in"));
 assert.equal(graph.counts.evidence,2);
 assert.equal(graph.counts.evidence_candidate,2);
 assert.ok(has("asset:asset-1","evidence:evidence-1","supports"));
 assert.ok(has("evidence:evidence-1","shot:shot-1","supports"));
 assert.ok(has("evidence:evidence-2","scene:scene-1","evidence_for"));
 assert.equal(graph.nodes.find(node=>node.id==="evidence:evidence-1").status,"linked");
 assert.equal(graph.nodes.find(node=>node.id==="evidence:evidence-2").status,"review");
 assert.equal(graph.counts.timeline,1);
});

test("change impact follows downstream dependencies and excludes the changed node",()=>{
 const graph=buildCreativeGraph(fixture);
 const impact=analyzeCreativeImpact(graph,"character:character-1");
 assert.deepEqual(impact.impacted.map(node=>node.id),["shot:shot-1","timeline:timeline-1"]);
 assert.equal(impact.impactedCount,2);
 assert.ok(impact.requiresReview.includes("timeline:timeline-1"));
});

test("graph does not invent character-to-shot links from names or descriptions",()=>{
 const input={...fixture,characters:[{id:"character-1",name:"Maya"}],seriesPlans:[{id:"series-1",seasons:[{episodes:[{id:"episode-1",scenes:[{id:"scene-1",title:"The problem",shots:[{id:"shot-1",prompt:"Maya appears"}]}]}]}]}]};
 const graph=buildCreativeGraph(input);
 assert.equal(graph.edges.some(edge=>edge.from==="character:character-1"&&edge.to==="shot:shot-1"),false);
});

test("impact analysis rejects unknown node IDs",()=>{
 assert.throws(()=>analyzeCreativeImpact(buildCreativeGraph(fixture),"missing"),/exists in the current creative graph/);
});


test("evidence with an unresolved target or mismatched source hash stays unlinked and review-only",()=>{
 const input={...fixture,evidenceRecords:[{id:"evidence-bad",projectId:"project-1",sourceAssetId:"asset-1",sourceSha256:"b".repeat(64),target:{type:"shot",id:"missing-shot"},kind:"testimony",claim:"An unverified statement from an unknown source.",status:"verified"}]};
 const graph=buildCreativeGraph(input);
 assert.deepEqual(graph.unlinkedEvidence,["evidence-bad"]);
 assert.equal(graph.nodes.find(node=>node.id==="evidence:evidence-bad").status,"review");
 assert.equal(graph.edges.some(edge=>edge.to==="shot:missing-shot"),false);
});
