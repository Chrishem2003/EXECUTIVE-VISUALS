import test from "node:test";
import assert from "node:assert/strict";
import { getProviderCapabilityAtlas } from "../provider-capability-atlas.mjs";

test("capability atlas separates implemented operations from documented but unintegrated operations",()=>{
 const atlas=getProviderCapabilityAtlas({runwayModel:"seedance2_5"});
 assert.equal(atlas.version,2);
 assert.equal(atlas.summary.models,6);
 assert.equal(atlas.summary.operations,12);
 assert.equal(atlas.summary.implementedOperations,2);
 assert.equal(atlas.summary.documentedNotIntegrated,10);
 const provider=atlas.providers[0];
 assert.equal(provider.id,"runway");
 assert.equal(provider.policy.credentialsExposed,false);
 assert.equal(provider.policy.requestsSubmitted,false);
 assert.equal(provider.policy.paidExecutionRequiresExplicitOptIn,true);
 assert.equal(provider.models.find(x=>x.id==="seedance2_5").selected,true);
 assert.equal(provider.models.find(x=>x.id==="seedance2_5").constraints.startFrame,true);
 assert.equal(provider.models.find(x=>x.id==="seedance2_5").constraints.endFrame,false);
 assert.equal(provider.operations.find(x=>x.id==="video.image_to_video").status,"implemented");
 assert.equal(provider.operations.find(x=>x.id==="video.video_to_video").status,"documented_not_integrated");
});
test("capability atlas does not select a model or enable unimplemented operations by default",()=>{
 const atlas=getProviderCapabilityAtlas();
 const provider=atlas.providers[0];
 assert.equal(provider.models.some(x=>x.selected),false);
 assert.ok(provider.operations.filter(x=>x.status==="documented_not_integrated").every(x=>x.readinessStages.at(-1).status==="not_verified"));
 assert.equal(provider.policy.unimplementedOperationsAreDisabled,true);
});
