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


test("pins derivative parent, processing fingerprint and AI review state into render source evidence",()=>{
 const processing={schemaVersion:1,engine:"realesrgan",method:"ai-super-resolution",model:"realesrgan-x4plus",modelVersion:"build-42",inputSha256:"a".repeat(64),outputSha256:"b".repeat(64),sourceAssetId:"asset-original",qualityReview:"not_reviewed"};
 const derived={path:"/private/derived.png",asset:{id:"asset-upscaled",mediaType:"image/png",size:200,sha256:"b".repeat(64),derivativeOf:"asset-original",metadata:{operation:"media.ai-upscale",processing}}};
 const result=createRenderManifest({timeline,assets:new Map([["asset-1",derived]]),timelineRevision:7});
 const evidence=result.sources[0].lineage;
 assert.equal(evidence.parentAssetId,"asset-original");
 assert.equal(evidence.sourceSha256,"a".repeat(64));
 assert.equal(evidence.modelVersion,"build-42");
 assert.equal(evidence.qualityReview,"not_reviewed");
 assert.equal(evidence.aiInferencePerformed,true);
 assert.equal(verifyRenderManifest(result),true);
 const changed=createRenderManifest({timeline,assets:new Map([["asset-1",{...derived,asset:{...derived.asset,metadata:{operation:"media.ai-upscale",processing:{...processing,modelVersion:"build-43"}}}}]]),timelineRevision:7});
 assert.notEqual(result.manifestSha256,changed.manifestSha256);
});

test("rejects derivative provenance whose parent conflicts with the asset relationship",()=>{
 const derived=asset("b".repeat(64));
 derived.asset.derivativeOf="asset-original";
 derived.asset.metadata={operation:"media.ai-upscale",processing:{sourceAssetId:"different-parent",inputSha256:"a".repeat(64)}};
 assert.throws(()=>createRenderManifest({timeline,assets:new Map([["asset-1",derived]]),timelineRevision:1}),e=>e.code==="RENDER_MANIFEST_LINEAGE_INVALID");
});


test("bounds and validates the processing evidence included in a derivative fingerprint",()=>{
 const base=asset("b".repeat(64));
 base.asset.derivativeOf="asset-original";
 base.asset.metadata={operation:"media.ai-upscale",processing:{sourceAssetId:"asset-original",inputSha256:"a".repeat(64),model:"safe-model",qualityReview:"not_reviewed",untrustedLargeField:"x".repeat(100000)}};
 const result=createRenderManifest({timeline,assets:new Map([["asset-1",base]]),timelineRevision:1});
 assert.equal(result.sources[0].lineage.model,"safe-model");
 assert.equal(Object.hasOwn(result.sources[0].lineage,"untrustedLargeField"),false);
 const invalid=asset("b".repeat(64));
 invalid.asset.derivativeOf="asset-original";
 invalid.asset.metadata={operation:"media.ai-upscale",processing:{sourceAssetId:"asset-original",inputSha256:"invalid"}};
 assert.throws(()=>createRenderManifest({timeline,assets:new Map([["asset-1",invalid]]),timelineRevision:1}),e=>e.code==="RENDER_MANIFEST_LINEAGE_INVALID");
});
