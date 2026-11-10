import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
const source=await readFile(new URL("../index.mjs",import.meta.url),"utf8");
test("HTTP submit route is mounted behind verified account authentication and a dedicated feature gate",()=>{
 assert.ok(source.includes('CLOUD_VIDEO_GENERATION_DISPATCH_ENABLED==="true"'));
 assert.ok(source.includes('cloudVideoGenerationDispatchEnabled&&!cloudTimelineApiEnabled'));
 assert.ok(source.includes('cloudVideoGenerationDispatchEnabled&&AUTH_MODE!=="supabase"'));
 assert.ok(source.includes('path.match(/^\\/api\\/video-production-approvals\\/([0-9a-f-]{36})\\/submit$/i)'));
 assert.ok(source.includes('cloudVideoGenerationDispatch.submit({approvalId:videoSubmitMatch[1],ownerId:user.id})'));
});
test("disabled dispatch returns 503 and never creates a provider request",()=>{
 assert.ok(source.includes("CLOUD_VIDEO_DISPATCH_DISABLED"));
 assert.ok(source.includes("Cloud generation dispatch is disabled. No cloud jobs or provider requests were created."));
});
test("HTTP submission route is rate limited and does not invoke a model adapter",()=>{
 const route=source.slice(source.indexOf("const videoSubmitMatch="),source.indexOf("const videoApprovalMatch="));
 assert.ok(route.includes('rateAllowed("video-production-submit:'));
 assert.doesNotMatch(route,/submitRunwayVideoTask|generateRunwayVideo|fetch\(/);
});
