import test from "node:test";
import assert from "node:assert/strict";
import {buildAssetLineage} from "../asset-lineage.mjs";
const asset=(id,derivativeOf=null)=>({id,derivativeOf,metadata:{operation:"media.ai-upscale"}});
test("builds ordered ancestry and descendants for a derivative chain",()=>{
 const result=buildAssetLineage({assetId:"c",assets:[asset("a"),asset("b","a"),asset("c","b"),asset("d","c")]});
 assert.deepEqual(result.ancestors.map(item=>item.id),["b","a"]);
 assert.deepEqual(result.descendants.map(item=>item.id),["d"]);
 assert.equal(result.nodeCount,4);assert.equal(result.truncated,false);
});
test("reports missing parents and detects cyclic lineage without looping",()=>{
 const missing=buildAssetLineage({assetId:"b",assets:[asset("b","not-loaded")]});
 assert.deepEqual(missing.ancestors,[{id:"not-loaded",missing:true}]);
 const cyclic=buildAssetLineage({assetId:"a",assets:[asset("a","b"),asset("b","a")]});
 assert.equal(cyclic.ancestors[0].id,"b");
 assert.equal(cyclic.ancestors[1].cycle,true);
 assert.equal(cyclic.descendants.some(item=>item.cycle),true);
});
test("bounds descendant count and traversal depth",()=>{
 const assets=[asset("root"),...Array.from({length:5},(_,i)=>asset("child-"+i,"root"))];
 const result=buildAssetLineage({assetId:"root",assets,maxNodes:2,maxDepth:2});
 assert.equal(result.descendants.length,2);assert.equal(result.truncated,true);
 assert.equal(buildAssetLineage({assetId:"absent",assets}),null);
 assert.throws(()=>buildAssetLineage({assetId:"root",assets,maxNodes:0}),/invalid/);
});
