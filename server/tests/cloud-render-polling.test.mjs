import test from "node:test";
import assert from "node:assert/strict";
import {hasCloudRenderJobFinished} from "../../src/platform/cloud-render-polling.ts";

test("active render becoming successful triggers output refresh",()=>{
 assert.equal(hasCloudRenderJobFinished([{id:"r1",status:"running"}],[{id:"r1",status:"succeeded"}]),true);
});
test("failed and cancelled renders are terminal transitions",()=>{
 assert.equal(hasCloudRenderJobFinished([{id:"r1",status:"queued"}],[{id:"r1",status:"failed"}]),true);
 assert.equal(hasCloudRenderJobFinished([{id:"r2",status:"running"}],[{id:"r2",status:"cancelled"}]),true);
 assert.equal(hasCloudRenderJobFinished([{id:"r3",status:"running"}],[{id:"r3",status:"canceled"}]),true);
});
test("queued or running progress does not trigger output refresh",()=>{
 assert.equal(hasCloudRenderJobFinished([{id:"r1",status:"queued"}],[{id:"r1",status:"running"}]),false);
});
test("already terminal jobs do not repeatedly refresh output",()=>{
 assert.equal(hasCloudRenderJobFinished([{id:"r1",status:"succeeded"}],[{id:"r1",status:"succeeded"}]),false);
});
test("unknown new jobs do not create false terminal transitions",()=>{
 assert.equal(hasCloudRenderJobFinished([{id:"r1",status:"running"}],[{id:"r2",status:"succeeded"}]),false);
});
test("status comparisons are case-insensitive and malformed records are ignored",()=>{
 assert.equal(hasCloudRenderJobFinished([{id:"r1",status:"RUNNING"}],[{id:"r1",status:"COMPLETED"}]),true);
 assert.equal(hasCloudRenderJobFinished([{id:"r1",status:"running"}],[{id:"",status:"succeeded"}]),false);
});
