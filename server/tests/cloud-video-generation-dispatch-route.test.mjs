import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../index.mjs",import.meta.url),"utf8");
test("HTTP submit route is mounted behind verified account authentication and a dedicated feature gate",()=>{
 assert.ok(source.includes('CLOUD_VIDEO_GENERATION_DISPATCH_ENABLED==="true"'));
 assert.ok(source.includes('cloudVideoGenerationDispatchEnabled&&!cloudTimelineApiEnabled'));
 assert.ok(source.includes('cloudVideoGenerationDispatchEnabled&&AUTH_MODE!=="supabase"'));
 assert.ok(source.includes('path.match(/^\\/api\\/video-production-approvals\\/([0-9a-f-]{36})\\/submit$/i)'));
 assert.ok(source.includes("const videoApprovalSubmitDispatch=neonStagingApprovalRuntime.enabled"));
 assert.ok(source.includes("videoApprovalSubmitDispatch.submit({approvalId:videoSubmitMatch[1],ownerId:user.id})"));
 assert.ok(source.includes("neonStagingApprovalRuntime.dispatch"));
});
test("disabled dispatch returns 503 and never creates a provider request",()=>{
 assert.ok(source.includes("VIDEO_GENERATION_DISPATCH_DISABLED"));
 assert.ok(source.includes("Video generation dispatch is disabled. No jobs or provider requests were created."));
 assert.ok(source.includes("const videoApprovalSubmitDispatch=neonStagingApprovalRuntime.enabled"));
 assert.ok(source.includes(":cloudVideoGenerationDispatch;"));
});
test("HTTP submission route is rate limited and does not invoke a model adapter",()=>{
 const route=source.slice(source.indexOf("const videoSubmitMatch="),source.indexOf("const videoApprovalMatch="));
 assert.ok(route.includes('rateAllowed("video-production-submit:'));
 assert.doesNotMatch(route,/submitRunwayVideoTask|generateRunwayVideo|fetch\(/);
});

test("cloud video cancellation route is authenticated and delegates owner identity from the session",()=>{
 assert.ok(source.includes('path.match(/^\\/api\\/video-generation-jobs\\/([0-9a-f-]{36})\\/cancel$/i)'));
 assert.ok(source.includes('cloudVideoGenerationDispatch.cancelJob({jobId:cloudVideoJobCancelMatch[1],ownerId:user.id})'));
});

test("Neon object storage origin is included in the media CSP without trusting arbitrary hosts",()=>{
 assert.ok(source.includes('if(provider==="neon")'));
 assert.ok(source.includes("process.env.NEON_STORAGE_ENDPOINT"));
 assert.ok(source.includes('value.pathname==="/"'));
 assert.ok(source.includes("aws\\.neon\\.tech"));
});

test("Neon staging job status is authenticated, owner-scoped, rate-limited and returns a bounded projection",()=>{
 const routeStart=source.indexOf("const neonVideoJobStatusMatch=");
 const routeEnd=source.indexOf("const cloudVideoJobCancelMatch=",routeStart);
 const route=source.slice(routeStart,routeEnd);
 assert.ok(routeStart>=0&&routeEnd>routeStart);
 assert.ok(route.includes('rateAllowed("neon-video-job-status:"+user.id'));
 assert.ok(route.includes('getOwnedJob(neonVideoJobStatusMatch[1],user.id)'));
 assert.ok(route.includes('listOwnedJobEvents(job.id,user.id,100)'));
 assert.ok(route.includes('job.status==="succeeded"'));
 assert.ok(route.includes('message:typeof error.message==="string"?error.message.slice(0,300)'));
 assert.doesNotMatch(route,/leaseToken|lease_token|providerTaskId|rawInput|job\.input/);
});
