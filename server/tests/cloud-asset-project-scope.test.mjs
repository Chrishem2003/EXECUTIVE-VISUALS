import test from "node:test";
import assert from "node:assert/strict";
import {cloudAssetProjectQuery,selectCloudAssetProject} from "../../src/platform/cloud-asset-project.ts";

const projectA={id:"123e4567-e89b-42d3-a456-426614174000",name:"Studio A"};
const projectB={id:"223e4567-e89b-42d3-a456-426614174001",name:"Studio B"};

test("keeps the selected cloud project when it remains available",()=>{
 assert.equal(selectCloudAssetProject(projectB.id,[projectA,projectB]),projectB.id);
});

test("falls back to the first valid cloud project when the selection disappears",()=>{
 assert.equal(selectCloudAssetProject("missing",[{id:"bad-id",name:"Invalid"},projectA,projectB]),projectA.id);
});

test("does not invent a project when no valid cloud projects exist",()=>{
 assert.equal(selectCloudAssetProject("",[{id:"bad-id",name:"Invalid"}]),"");
});

test("builds an encoded, project-scoped asset query",()=>{
 assert.equal(cloudAssetProjectQuery(projectA.id),"?projectId="+projectA.id+"&limit=25");
 assert.equal(cloudAssetProjectQuery(projectA.id,100),"?projectId="+projectA.id+"&limit=100");
});

test("refuses unscoped or invalid cloud asset queries",()=>{
 assert.equal(cloudAssetProjectQuery(""),null);
 assert.equal(cloudAssetProjectQuery("not-a-uuid"),null);
 assert.equal(cloudAssetProjectQuery(projectA.id,0),null);
 assert.equal(cloudAssetProjectQuery(projectA.id,101),null);
});
