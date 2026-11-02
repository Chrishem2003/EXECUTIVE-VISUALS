import test from "node:test";
import assert from "node:assert/strict";
import {createRenderManifest,verifyRenderManifest} from "../render-manifest.mjs";
const time=value=>({value,rate:1});
const asset=(sha="a".repeat(64))=>({path:"/private/source.mp4",asset:{id:"asset-1",mediaType:"video/mp4",size:100,sha256:sha}});
const timeline={name:"Pinned cut",tracks:[{id:"v",kind:"video",clips:[{id:"c1",assetId:"asset-1",timelineStart:time(0),duration:time(4),sourceRange:{start:time(2),duration:time(4)}}]}]};
test("creates a deterministic manifest pinned to revision, output settings and source checksum",()=>{
 const assets=new Map([["asset-1",asset()]]);
 const a=createRenderManifest({timeline,assets,timelineRevision:7,output:{width:1920,height:1080,codec:"h264"}});
 const b=createRenderManifest({timeline,assets,timelineRevision:7,output:{width:1920,height:1080,codec:"h264"}});
 assert.equal(a.manifestSha256,b.manifestSha256);
 assert.equal(a.sources[0].sha256,"a".repeat(64));
 assert.equal(verifyRenderManifest(a),true);
 assert.equal(verifyRenderManifest({...a,timelineRevision:"8"}),false);
});
test("changes the fingerprint when the timeline revision, source checksum or output profile changes",()=>{
 const base={timeline,assets:new Map([["asset-1",asset()]]),timelineRevision:1,output:{codec:"h264"}};
 const a=createRenderManifest(base);
 assert.notEqual(a.manifestSha256,createRenderManifest({...base,timelineRevision:2}).manifestSha256);
 assert.notEqual(a.manifestSha256,createRenderManifest({...base,assets:new Map([["asset-1",asset("b".repeat(64))]])}).manifestSha256);
 assert.notEqual(a.manifestSha256,createRenderManifest({...base,output:{codec:"hevc"}}).manifestSha256);
});
test("refuses unverified or missing source assets and invalid revisions",()=>{
 assert.throws(()=>createRenderManifest({timeline,assets:new Map([["asset-1",asset("bad")]]),timelineRevision:1}),e=>e.code==="RENDER_MANIFEST_SOURCE_UNVERIFIED");
 assert.throws(()=>createRenderManifest({timeline,assets:new Map(),timelineRevision:1}),e=>e.code==="SOURCE_ASSET_NOT_FOUND");
 assert.throws(()=>createRenderManifest({timeline,assets:new Map([["asset-1",asset()]]),timelineRevision:null}),e=>e.code==="RENDER_MANIFEST_REVISION_REQUIRED");
});
test("ignores disabled clips and disabled tracks",()=>{
 const disabled={tracks:[{enabled:false,clips:[{assetId:"missing"}]},{kind:"video",clips:[{enabled:false,assetId:"missing"}]}]};
 const result=createRenderManifest({timeline:disabled,assets:new Map(),timelineRevision:"rev-1"});
 assert.deepEqual(result.sources,[]);
 assert.equal(verifyRenderManifest(result),true);
});
