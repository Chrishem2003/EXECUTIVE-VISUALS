import test from "node:test";
import assert from "node:assert/strict";
import { buildRunwayRouterDryRunPayload, createRunwayRouterDryRunClient } from "../runway-router-dry-run.mjs";

test("builds a dry-run-only Model Router payload", () => {
  const payload = buildRunwayRouterDryRunPayload({ configId:"preview-fast", prompt:"  A cinematic sunrise over Kampala  ", durationSeconds:5, aspectRatio:"16:9", resolution:"720p" });
  assert.deepEqual(payload,{configId:"preview-fast",dryRun:true,input:{promptText:"A cinematic sunrise over Kampala",duration:5,aspectRatio:"16:9",resolution:"720p"}});
});
test("rejects invalid router slugs and out-of-range duration", () => {
  assert.throws(()=>buildRunwayRouterDryRunPayload({configId:"../prod",prompt:"test"}),error=>error.code==="RUNWAY_ROUTER_CONFIG_INVALID");
  assert.throws(()=>buildRunwayRouterDryRunPayload({configId:"preview-fast",prompt:"test",durationSeconds:31}),/duration/);
});
test("does not contact Runway while remote preflight is disabled", async () => {
  let fetchCalls=0;
  const client=createRunwayRouterDryRunClient({env:{RUNWAY_ROUTER_PREFLIGHT_ENABLED:"false",RUNWAY_VIDEO_ALLOW_REMOTE:"true",RUNWAY_API_KEY:"test-only"},fetchImpl:async()=>{fetchCalls++;throw new Error("unexpected network call");}});
  await assert.rejects(client.preflight({configId:"preview-fast",prompt:"test"}),error=>error.code==="RUNWAY_ROUTER_PREFLIGHT_DISABLED");
  assert.equal(fetchCalls,0);
});
test("requires authenticated project scope before resolving private reference assets", async () => {
  let fetchCalls=0;
  const client=createRunwayRouterDryRunClient({env:{RUNWAY_ROUTER_PREFLIGHT_ENABLED:"true",RUNWAY_VIDEO_ALLOW_REMOTE:"true",RUNWAY_API_KEY:"test-only"},resolvePrivateAsset:async()=>({uri:"https://assets.example.test/reference.png"}),fetchImpl:async()=>{fetchCalls++;throw new Error("unexpected network call");}});
  await assert.rejects(client.preflight({configId:"preview-fast",prompt:"test",projectId:"project-1",referenceImages:[{assetId:"asset-1",role:"first"}]}),error=>error.code==="RUNWAY_ROUTER_ASSET_AUTH_REQUIRED");
  assert.equal(fetchCalls,0);
});
