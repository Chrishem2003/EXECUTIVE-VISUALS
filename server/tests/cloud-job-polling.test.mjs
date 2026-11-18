import test from "node:test";
import assert from "node:assert/strict";
import { hasCloudJobFinished, shouldPollCloudJobs, isCloudJobTerminal, CLOUD_JOB_POLL_INTERVAL_MS } from "../../src/platform/cloud-job-polling.ts";

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

test("submitted jobs poll while visible and stop when all jobs are terminal",()=>{
 const approval={submitted:true,jobIds:["job-1","job-2"],jobStatuses:[{jobId:"job-1",status:"succeeded"},{jobId:"job-2",status:"running"}]};
 assert.equal(shouldPollCloudJobs(approval,true),true);
 assert.equal(shouldPollCloudJobs(approval,false),false);
 assert.equal(shouldPollCloudJobs({...approval,jobStatuses:[{jobId:"job-1",status:"succeeded"},{jobId:"job-2",status:"failed"}]},true),false);
 assert.equal(shouldPollCloudJobs({...approval,submitted:false},true),false);
 assert.equal(shouldPollCloudJobs({...approval,jobIds:[]},true),false);
});

test("unknown jobs remain pollable until the server reports a terminal state",()=>{
 assert.equal(shouldPollCloudJobs({submitted:true,jobIds:["job-1"],jobStatuses:[]},true),true);
 assert.equal(isCloudJobTerminal("cancelled"),true);
 assert.equal(isCloudJobTerminal("SUCCEEDED"),true);
 assert.equal(isCloudJobTerminal("cancel_requested"),false);
 assert.equal(CLOUD_JOB_POLL_INTERVAL_MS,5000);
});
