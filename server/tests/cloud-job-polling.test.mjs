import test from "node:test";
import assert from "node:assert/strict";
import { hasCloudJobFinished } from "../../src/platform/cloud-job-polling.ts";

test("queued to running does not count as completion",()=>{
 assert.equal(hasCloudJobFinished([{id:"job-1",status:"queued"}],[{id:"job-1",status:"running"}]),false);
});

test("running to completed refreshes generated asset metadata",()=>{
 assert.equal(hasCloudJobFinished([{id:"job-1",status:"running"}],[{id:"job-1",status:"completed"}]),true);
});

test("running to failed and cancelled are terminal transitions",()=>{
 assert.equal(hasCloudJobFinished([{id:"job-1",status:"running"}],[{id:"job-1",status:"failed"}]),true);
 assert.equal(hasCloudJobFinished([{id:"job-2",status:"queued"}],[{id:"job-2",status:"cancelled"}]),true);
 assert.equal(hasCloudJobFinished([{id:"job-3",status:"queued"}],[{id:"job-3",status:"canceled"}]),true);
});

test("already terminal jobs do not repeatedly trigger a library refresh",()=>{
 assert.equal(hasCloudJobFinished([{id:"job-1",status:"completed"}],[{id:"job-1",status:"completed"}]),false);
});

test("unseen terminal jobs and unrelated IDs do not trigger a false transition",()=>{
 assert.equal(hasCloudJobFinished([{id:"job-1",status:"queued"}],[{id:"job-2",status:"completed"}]),false);
});

test("status matching is case-insensitive and ignores malformed rows",()=>{
 assert.equal(hasCloudJobFinished([{id:"job-1",status:"RUNNING"}],[{id:"job-1",status:"SUCCEEDED"}]),true);
 assert.equal(hasCloudJobFinished([{id:"job-1",status:"running"}],[{id:"",status:"completed"}]),false);
});
