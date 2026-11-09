import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,readFile,rm,writeFile,symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createUpscaleReviewPackage } from "../upscale-review-package.mjs";
const categories=["portrait","fine_texture","text","animation","low_light_noisy"];
const hash=b=>createHash("sha256").update(b).digest("hex");
async function setup(t){
 const root=await mkdtemp(join(tmpdir(),"ev-upscale-review-")),fixtures=join(root,"fixtures"),run=join(root,"run");
 await mkdir(fixtures);await mkdir(run);
 const manifest={fixtures:categories.map(c=>({fixtureId:"fixture-"+c,fixtureCategory:c,path:"fixtures/"+c+".png",scale:2}))},records=[];
 for(const f of manifest.fixtures){const input=Buffer.from("source-"+f.fixtureCategory),output=Buffer.from("enhanced-"+f.fixtureCategory);await writeFile(join(fixtures,f.fixtureCategory+".png"),input);await writeFile(join(run,f.fixtureId+".png"),output);records.push({fixtureId:f.fixtureId,fixtureCategory:f.fixtureCategory,model:"realesrgan-x4plus",modelVersion:"sha256:pinned",binarySha256:"a".repeat(64),modelFilesSha256:"b".repeat(64),inputSha256:hash(input),outputSha256:hash(output),inputWidth:10,inputHeight:8,outputWidth:20,outputHeight:16,scale:2,durationMs:20,executionStatus:"passed",qualityReview:"not_reviewed",timestamp:"2026-11-09T00:00:00.000Z"});}
 const reportPath=join(root,"report.json"),manifestPath=join(root,"manifest.json"),outputDirectory=join(root,"review");
 await writeFile(reportPath,JSON.stringify({schemaVersion:1,model:"realesrgan-x4plus",modelVersion:"sha256:pinned",generatedAt:"2026-11-09T00:00:00.000Z",records}));await writeFile(manifestPath,JSON.stringify(manifest));t.after(()=>rm(root,{recursive:true,force:true}));return{root,fixtures,run,reportPath,manifestPath,outputDirectory};
}
test("creates a checksum-verified five-fixture human review package",async t=>{const e=await setup(t),r=await createUpscaleReviewPackage({...e,runDirectory:e.run});assert.equal(r.fixtureCount,5);assert.equal(r.qualityVerified,false);const html=await readFile(r.htmlPath,"utf8");assert.match(html,/Human visual assessment/);assert.match(html,/Export review notes JSON/);assert.match(html,/NOT REVIEWED/);assert.match(html,/Reviewer name/);assert.match(html,/at least 20 characters/);assert.match(html,/REVIEWED · PASS/);const manifest=JSON.parse(await readFile(r.reviewManifestPath,"utf8"));assert.equal(manifest.fixtures.length,5);assert.equal(manifest.qualityVerified,false);});
test("rejects changed output bytes before creating a package",async t=>{const e=await setup(t);await writeFile(join(e.run,"fixture-portrait.png"),"tampered");await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/checksum mismatch/);});
test("rejects symlinked run directories",async t=>{const e=await setup(t),link=join(e.root,"run-link");await symlink(e.run,link);await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:link}),/regular directory/);});
test("refuses to overwrite an existing review package directory",async t=>{const e=await setup(t);await mkdir(e.outputDirectory);await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/already exists/);});
