import test from "node:test";
import assert from "node:assert/strict";
import { createKiePrivateAssetResolver } from "../kie-private-asset-resolver.mjs";

const ownerId="123e4567-e89b-42d3-a456-426614174000";
const projectId="323e4567-e89b-42d3-a456-426614174000";
const ids=["423e4567-e89b-42d3-a456-426614174000","523e4567-e89b-42d3-a456-426614174000","623e4567-e89b-42d3-a456-426614174000"];
const url=id=>"https://storage.example.com/private/"+id+"?token=signed";
function asset(id,overrides={}){return{id,ownerId,projectId,mediaType:"image/png",size:1024,url:url(id),...overrides};}
function make(overrides={}){const calls=[];const assets={async createSignedUrl(args){calls.push(args);return{asset:asset(args.assetId),url:url(args.assetId)};},...overrides};return{resolver:createKiePrivateAssetResolver({assets}),calls};}
const input=(extra={})=>({provider:"kie",model:"bytedance/seedance-2",prompt:"A storyboard frame",durationSeconds:5,...extra});
const job={owner_id:ownerId,project_id:projectId};

test("resolves owner/project-scoped first/last frames and reference images to short-lived signed URLs",async()=>{
 const {resolver,calls}=make();
 const result=await resolver(input({startFrameAssetId:ids[0],endFrameAssetId:ids[1]}),{job});
 assert.equal(result.firstFrameUrl,url(ids[0]));
 assert.equal(result.lastFrameUrl,url(ids[1]));
 assert.equal(calls.length,2);
 assert.ok(calls.every(call=>call.ownerId===ownerId&&call.expiresIn===3600));
 const refs=await resolver(input({referenceAssetIds:ids}),{job});
 assert.deepEqual(refs.referenceImageUrls,ids.map(url));
});

test("rejects direct URLs, invalid job scope and mixed reference modes",async()=>{
 const {resolver}=make();
 await assert.rejects(resolver(input({firstFrameUrl:"https://attacker.example/image.png"}),{job}),error=>error.code==="KIE_VIDEO_INPUT_DIRECT_URL_REJECTED");
 await assert.rejects(resolver(input({referenceAssetIds:ids,startFrameAssetId:ids[0]}),{job}),error=>error.code==="KIE_VIDEO_INPUT_MODE_CONFLICT");
 await assert.rejects(resolver(input({startFrameAssetId:ids[0],endFrameAssetId:ids[1]}),{job:{owner_id:"not-a-uuid",project_id:projectId}}),error=>error.code==="KIE_VIDEO_INPUT_SCOPE_INVALID");
});

test("rejects assets from another owner/project, unsupported types and oversized files",async()=>{
 const wrongOwner=make({async createSignedUrl(args){return{asset:asset(args.assetId,{ownerId:"223e4567-e89b-42d3-a456-426614174000"}),url:url(args.assetId)};}});
 await assert.rejects(wrongOwner.resolver(input({referenceAssetIds:[ids[0]]}),{job}),error=>error.code==="KIE_VIDEO_INPUT_ASSET_INVALID");
 const wrongProject=make({async createSignedUrl(args){return{asset:asset(args.assetId,{projectId:"723e4567-e89b-42d3-a456-426614174000"}),url:url(args.assetId)};}});
 await assert.rejects(wrongProject.resolver(input({referenceAssetIds:[ids[0]]}),{job}),error=>error.code==="KIE_VIDEO_INPUT_ASSET_INVALID");
 const wrongType=make({async createSignedUrl(args){return{asset:asset(args.assetId,{mediaType:"application/pdf"}),url:url(args.assetId)};}});
 await assert.rejects(wrongType.resolver(input({referenceAssetIds:[ids[0]]}),{job}),error=>error.code==="KIE_VIDEO_INPUT_ASSET_INVALID");
 const tooLarge=make({async createSignedUrl(args){return{asset:asset(args.assetId,{size:31*1024*1024}),url:url(args.assetId)};}});
 await assert.rejects(tooLarge.resolver(input({referenceAssetIds:[ids[0]]}),{job}),error=>error.code==="KIE_VIDEO_INPUT_ASSET_INVALID");
});

test("rejects unsafe signed URLs, duplicate IDs and excess references",async()=>{
 const unsafe=make({async createSignedUrl(args){return{asset:asset(args.assetId),url:"https://127.0.0.1/private"};}});
 await assert.rejects(unsafe.resolver(input({referenceAssetIds:[ids[0]]}),{job}),error=>error.code==="KIE_VIDEO_INPUT_ASSET_URL_INVALID");
 const {resolver}=make();
 await assert.rejects(resolver(input({referenceAssetIds:[ids[0],ids[0]]}),{job}),error=>error.code==="KIE_VIDEO_INPUT_INVALID");
 const ten=Array.from({length:10},(_,i)=>"a23e4567-e89b-42d3-a456-"+String(i+100).padStart(4,"0")+"000000000000");
 await assert.rejects(resolver(input({referenceAssetIds:ten}),{job}),error=>error.code==="KIE_VIDEO_INPUT_INVALID");
 await assert.rejects(resolver(input({referenceVideoAssetIds:[ids[0]]}),{job}),error=>error.code==="KIE_VIDEO_CAPABILITY_UNSUPPORTED");
});

test("requires a real private asset repository and bounded signed URL expiry",()=>{
 assert.throws(()=>createKiePrivateAssetResolver({assets:{}}),/private cloud asset repository/);
 assert.throws(()=>createKiePrivateAssetResolver({assets:{createSignedUrl:async()=>({})},expiresIn:60}),/between 5 and 60 minutes/);
});
