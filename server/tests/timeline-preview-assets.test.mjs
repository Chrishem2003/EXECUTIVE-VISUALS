import test from "node:test";
import assert from "node:assert/strict";
import { selectPreviewAsset } from "../../src/core/timeline-preview-assets.ts";

const source={id:"source",mediaType:"video/quicktime",size:1000,sha256:"a".repeat(64)};
const proxy=(id,size,overrides={})=>({id,mediaType:"video/mp4",size,sha256:"b".repeat(64),derivativeOf:"source",metadata:{operation:"media.proxy"},...overrides});

test("selects the smallest verified proxy linked to the exact video source",()=>{
 const assets=[proxy("large",600),proxy("small",300),proxy("wrong-source",100,{derivativeOf:"other"})];
 const result=selectPreviewAsset(source,assets);
 assert.equal(result.mode,"proxy");
 assert.equal(result.asset.id,"small");
});

test("falls back to original when no smaller verified proxy exists",()=>{
 const result=selectPreviewAsset(source,[proxy("large",1200),proxy("bad-hash",200,{sha256:"not-a-sha256"}),proxy("wrong-operation",100,{metadata:{operation:"media.transcode"}})]);
 assert.equal(result.mode,"original");
 assert.equal(result.asset.id,"source");
});

test("never selects a proxy for images or audio",()=>{
 const image={id:"image",mediaType:"image/png",size:1000};
 const audio={id:"audio",mediaType:"audio/mpeg",size:1000};
 assert.equal(selectPreviewAsset(image,[proxy("proxy-image",50,{derivativeOf:"image"})]).asset.id,"image");
 assert.equal(selectPreviewAsset(audio,[proxy("proxy-audio",50,{derivativeOf:"audio"})]).asset.id,"audio");
});

test("rejects invalid source sizes and proxy sizes",()=>{
 const invalid={...source,size:0};
 assert.equal(selectPreviewAsset(invalid,[proxy("p",100)]).mode,"original");
 assert.equal(selectPreviewAsset(source,[proxy("empty",0)]).mode,"original");
});
