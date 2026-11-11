import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,readFile,rm,writeFile,symlink,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createUpscaleReviewPackage, validateUpscaleHumanReviewNotes } from "../upscale-review-package.mjs";
const categories=["portrait","fine_texture","text","animation","low_light_noisy"];
const hash=b=>createHash("sha256").update(b).digest("hex");
function pngChunk(type,data){const name=Buffer.from(type),body=Buffer.concat([name,data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const checksum=(crc^0xffffffff)>>>0;const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const tail=Buffer.alloc(4);tail.writeUInt32BE(checksum);return Buffer.concat([length,body,tail]);}
function pngBytes(width,height,pixelValue=0){const signature=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;const stride=1+width*4,rows=Buffer.alloc(height*stride);for(let y=0;y<height;y++)rows.fill(pixelValue,y*stride+1,(y+1)*stride);return Buffer.concat([signature,pngChunk("IHDR",ihdr),pngChunk("IDAT",deflateSync(rows)),pngChunk("IEND",Buffer.alloc(0))]);}

async function setup(t, model="realesrgan-x4plus"){
 const root=await mkdtemp(join(tmpdir(),"ev-upscale-review-")),fixtures=join(root,"fixtures"),run=join(root,"run");
 await mkdir(fixtures);await mkdir(run);
 const manifest={fixtures:categories.map(c=>({fixtureId:"fixture-"+c,fixtureCategory:c,path:"fixtures/"+c+".png",scale:2}))},records=[];
 for(const f of manifest.fixtures){const input=pngBytes(10,8),output=pngBytes(20,16);await writeFile(join(fixtures,f.fixtureCategory+".png"),input);await writeFile(join(run,f.fixtureId+".png"),output);records.push({fixtureId:f.fixtureId,fixtureCategory:f.fixtureCategory,model,modelVersion:"sha256:pinned",binarySha256:"a".repeat(64),modelFilesSha256:"b".repeat(64),inputSha256:hash(input),outputSha256:hash(output),inputWidth:10,inputHeight:8,outputWidth:20,outputHeight:16,scale:2,durationMs:20,requestedTile:128,tile:128,tileFallbackUsed:false,tileAttempts:[128],executionStatus:"passed",qualityReview:"not_reviewed",timestamp:"2026-11-09T00:00:00.000Z"});}
 const reportPath=join(root,"report.json"),manifestPath=join(root,"manifest.json"),outputDirectory=join(root,"review");
 await writeFile(reportPath,JSON.stringify({schemaVersion:1,model,modelVersion:"sha256:pinned",generatedAt:"2026-11-09T00:00:00.000Z",records}));await writeFile(manifestPath,JSON.stringify(manifest));t.after(()=>rm(root,{recursive:true,force:true}));return{root,fixtures,run,reportPath,manifestPath,outputDirectory};
}
test("creates model-isolated review packages for the documented anime and general variants",async t=>{
 for(const model of ["realesrgan-x4plus-anime","realesr-animevideov3","realesrnet-x4plus"]){
  const e=await setup(t,model),r=await createUpscaleReviewPackage({...e,runDirectory:e.run});
  assert.equal(r.fixtureCount,5);assert.equal(r.qualityVerified,false);
  const manifest=JSON.parse(await readFile(r.reviewManifestPath,"utf8"));assert.equal(manifest.model,model);
 }
});
test("creates a checksum-verified five-fixture human review package",async t=>{const e=await setup(t),r=await createUpscaleReviewPackage({...e,runDirectory:e.run});assert.equal(r.fixtureCount,5);assert.equal(r.qualityVerified,false);const html=await readFile(r.htmlPath,"utf8");assert.match(html,/Human visual assessment/);assert.match(html,/Required quality rubric/);assert.match(html,/data-check="detailRetention"/);assert.match(html,/data-check="edgeTextIntegrity"/);assert.match(html,/data-check="artifactControl"/);assert.match(html,/data-check="colorToneConsistency"/);assert.match(html,/data-check="naturalAppearance"/);assert.match(html,/reviewProtocol:"ev-upscale-rubric-v1"/);assert.match(html,/A fixture with a reported quality issue cannot be marked Pass/);assert.match(html,/Metric scores must not override visual review/);assert.match(html,/Export review notes JSON/);assert.match(html,/id="export" disabled aria-describedby="export-readiness"/);assert.match(html,/id="export-readiness" class="footer" role="status" aria-live="polite"/);assert.match(html,/ready=reviewed===cards\.length&&reviewer\.length>=2&&reviewer\.length<=120/);assert.match(html,/document\.getElementById\("export"\)\.disabled=!ready/);assert.match(html,/All five reviews are complete\. Export is ready\./);assert.match(html,/addEventListener\("input",updateSummary\)/);assert.match(html,/Review progress/);assert.match(html,/Filter review fixtures/);assert.match(html,/id="review-filter"/);assert.match(html,/Needs attention/);assert.match(html,/Completed pass/);assert.match(html,/Completed fail/);assert.match(html,/id="review-search"/);assert.match(html,/function filterFixtures\(\)/);assert.match(html,/Showing "\+visible\+" of "\+cards\.length\+" fixtures/);assert.match(html,/card\.hidden=!show/);assert.match(html,/aria-live="polite"/);assert.match(html,/reviewed-count/);assert.match(html,/pass-count/);assert.match(html,/fail-count/);assert.match(html,/rubric-count/);assert.match(html,/aria-valuenow/);assert.match(html,/function isReviewComplete\(card\)/);assert.match(html,/complete=isReviewComplete\(card\)/);assert.match(html,/INCOMPLETE · REVIEW/);assert.match(html,/badge\.className=complete\?/);assert.match(html,/syncDecision\(card\);updateSummary\(\);filterFixtures\(\)/);assert.match(html,/notes\.length>=20/);assert.match(html,/checks\.length===5/);assert.match(html,/passHasIssue=decision===\"reviewed_pass\"&&checks\.some\(control=>control\.value===\"issue\"\)/);assert.match(html,/assessed&&!passHasIssue/);assert.match(html,/function updateSummary\(\)/);assert.match(html,/addEventListener\("input",\(\)=>\{syncDecision\(card\);updateSummary\(\);filterFixtures\(\);\}\)/);assert.match(html,/updateSummary\(\);/);assert.match(html,/Tile execution/);assert.match(html,/Tile attempts/);assert.match(html,/Requested 128 → actual 128/);assert.match(html,/data-zoom="source"/);assert.match(html,/data-zoom="enhanced"/);assert.match(html,/100 percent image inspection/);assert.match(html,/dialog.showModal\(\)/);assert.match(html,/max-width:none;max-height:none/);assert.match(html,/control\.value="not_assessed"/);assert.match(html,/style\.setProperty\("--reveal","50%"\)/);assert.match(html,/querySelector\(\x27input\[type="range"\]\x27\)/);assert.match(html,/NOT REVIEWED/);assert.match(html,/Reviewer name/);assert.match(html,/data-input-sha256/);assert.match(html,/data-output-sha256/);assert.match(html,/fixtureCategory:card.dataset.category/);assert.match(html,/at least 20 characters/);assert.match(html,/REVIEWED · PASS/);assert.match(html,/setTimeout\(\(\)=>URL\.revokeObjectURL\(url\),60000\)/);const manifest=JSON.parse(await readFile(r.reviewManifestPath,"utf8"));assert.equal(manifest.fixtures.length,5);assert.equal(manifest.qualityVerified,false);assert.ok(manifest.fixtures.every(fixture=>fixture.requestedTile===128&&fixture.tile===128&&fixture.tileFallbackUsed===false&&fixture.tileAttempts[0]===128));const rootInfo=await stat(e.outputDirectory),assetsInfo=await stat(join(e.outputDirectory,"assets")),sourceInfo=await stat(join(e.outputDirectory,"assets","fixture-portrait-source.png")),outputInfo=await stat(join(e.outputDirectory,"assets","fixture-portrait-enhanced.png"));assert.equal(rootInfo.mode&0o777,0o700);assert.equal(assetsInfo.mode&0o777,0o700);assert.equal(sourceInfo.mode&0o777,0o600);assert.equal(outputInfo.mode&0o777,0o600);});
test("preserves unavailable tile provenance without inventing defaults",async t=>{const e=await setup(t),report=JSON.parse(await readFile(e.reportPath,"utf8"));for(const record of report.records){delete record.requestedTile;delete record.tile;delete record.tileFallbackUsed;delete record.tileAttempts;}await writeFile(e.reportPath,JSON.stringify(report));const r=await createUpscaleReviewPackage({...e,runDirectory:e.run}),html=await readFile(r.htmlPath,"utf8"),manifest=JSON.parse(await readFile(r.reviewManifestPath,"utf8"));assert.match(html,/Requested not recorded → actual not recorded · fallback not recorded/);assert.ok(html.includes("Tile attempts</dt><dd>not recorded</dd>"));assert.ok(manifest.fixtures.every(fixture=>fixture.requestedTile===null&&fixture.tile===null&&fixture.tileFallbackUsed===null&&fixture.tileAttempts.length===0));});
test("rejects changed output bytes before creating a package",async t=>{const e=await setup(t),path=join(e.run,"fixture-portrait.png"),original=await readFile(path),changed=pngBytes(20,16,1);assert.notEqual(hash(changed),hash(original));await writeFile(path,changed);await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/checksum mismatch/);});
test("rejects symlinked run directories",async t=>{const e=await setup(t),link=join(e.root,"run-link");await symlink(e.run,link);await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:link}),/regular directory/);});
test("refuses to overwrite an existing review package directory",async t=>{const e=await setup(t);await mkdir(e.outputDirectory);await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/already exists/);});

test("rejects fixture symlinks that point outside the manifest directory",async t=>{
 const e=await setup(t),fixture=join(e.fixtures,"portrait.png"),outside=join(e.run,"outside.png");
 await writeFile(outside,"outside-private-image");
 await rm(fixture);
 await symlink(outside,fixture);
 await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/regular non-symlink/);
});
test("rejects manifest fixture paths that traverse outside the fixture root",async t=>{
 const e=await setup(t),manifest=JSON.parse(await readFile(e.manifestPath,"utf8"));
 manifest.fixtures[0].path="../run/fixture-portrait.png";
 await writeFile(e.manifestPath,JSON.stringify(manifest));
 await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/cannot traverse|remain relative/);
});
test("rejects benchmark records whose model identity differs from the report",async t=>{
 const e=await setup(t),report=JSON.parse(await readFile(e.reportPath,"utf8"));
 report.records[0].model="realesrgan-x4plus-anime";
 await writeFile(e.reportPath,JSON.stringify(report));
 await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/invalid|match the report model/);
});

test("rejects a valid PNG whose actual dimensions disagree with benchmark evidence",async t=>{
 const e=await setup(t),output=pngBytes(40,32),report=JSON.parse(await readFile(e.reportPath,"utf8"));
 await writeFile(join(e.run,"fixture-portrait.png"),output);
 report.records[0].outputSha256=hash(output);
 await writeFile(e.reportPath,JSON.stringify(report));
 await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/dimensions do not match/);
});
test("rejects a non-PNG enhanced output even when its checksum matches the report",async t=>{
 const e=await setup(t),output=Buffer.from("not-a-png"),report=JSON.parse(await readFile(e.reportPath,"utf8"));
 await writeFile(join(e.run,"fixture-portrait.png"),output);
 report.records[0].outputSha256=hash(output);
 await writeFile(e.reportPath,JSON.stringify(report));
 await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/complete PNG|valid PNG/);
});

test("rejects PNG data with an invalid IHDR CRC even when its file checksum matches",async t=>{
 const e=await setup(t),output=Buffer.from(pngBytes(20,16)),report=JSON.parse(await readFile(e.reportPath,"utf8"));
 output[29]^=0xff;
 await writeFile(join(e.run,"fixture-portrait.png"),output);
 report.records[0].outputSha256=hash(output);
 await writeFile(e.reportPath,JSON.stringify(report));
 await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/invalid chunk checksum/);
});
test("rejects PNG files with a corrupted IDAT CRC even when the file checksum matches",async t=>{
 const e=await setup(t),output=Buffer.from(pngBytes(20,16)),report=JSON.parse(await readFile(e.reportPath,"utf8"));
 const idatLength=output.readUInt32BE(33),idatCrcOffset=33+8+idatLength;
 output[idatCrcOffset]^=0xff;
 await writeFile(join(e.run,"fixture-portrait.png"),output);
 report.records[0].outputSha256=hash(output);
 await writeFile(e.reportPath,JSON.stringify(report));
 await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/invalid chunk checksum/);
});
test("rejects non-consecutive IDAT chunks",async t=>{
 const e=await setup(t),valid=pngBytes(20,16),report=JSON.parse(await readFile(e.reportPath,"utf8"));
 const ihdrEnd=8+8+13+4,idatLength=valid.readUInt32BE(ihdrEnd),idatStart=ihdrEnd+8,idatData=valid.subarray(idatStart,idatStart+idatLength);
 const split=Math.max(1,Math.floor(idatData.length/2));
 const output=Buffer.concat([valid.subarray(0,ihdrEnd),pngChunk("IDAT",idatData.subarray(0,split)),pngChunk("tEXt",Buffer.from("Comment\\0split")),pngChunk("IDAT",idatData.subarray(split)),pngChunk("IEND",Buffer.alloc(0))]);
 await writeFile(join(e.run,"fixture-portrait.png"),output);report.records[0].outputSha256=hash(output);await writeFile(e.reportPath,JSON.stringify(report));
 await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/IDAT chunks must be consecutive/);
});
test("rejects an unsupported critical PNG chunk",async t=>{
 const e=await setup(t),valid=pngBytes(20,16),report=JSON.parse(await readFile(e.reportPath,"utf8"));
 const ihdrEnd=8+8+13+4,output=Buffer.concat([valid.subarray(0,ihdrEnd),pngChunk("ABCD",Buffer.alloc(0)),valid.subarray(ihdrEnd)]);
 await writeFile(join(e.run,"fixture-portrait.png"),output);report.records[0].outputSha256=hash(output);await writeFile(e.reportPath,JSON.stringify(report));
 await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/unsupported critical chunk/);
});
test("rejects a PLTE chunk for grayscale PNG output",async t=>{
 const e=await setup(t),valid=pngBytes(20,16),report=JSON.parse(await readFile(e.reportPath,"utf8"));
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(20,0);ihdr.writeUInt32BE(16,4);ihdr[8]=8;ihdr[9]=0;
 const idatLength=valid.readUInt32BE(33),idatStart=41,idat=valid.subarray(33,idatStart+idatLength+4),output=Buffer.concat([valid.subarray(0,8),pngChunk("IHDR",ihdr),pngChunk("PLTE",Buffer.from([0,0,0])),idat,valid.subarray(idatStart+idatLength+4)]);
 await writeFile(join(e.run,"fixture-portrait.png"),output);report.records[0].outputSha256=hash(output);await writeFile(e.reportPath,JSON.stringify(report));
 await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/invalid or misplaced PLTE/);
});
test("rejects PNG files truncated before IEND",async t=>{
 const e=await setup(t),valid=pngBytes(20,16),output=valid.subarray(0,valid.length-12),report=JSON.parse(await readFile(e.reportPath,"utf8"));
 await writeFile(join(e.run,"fixture-portrait.png"),output);
 report.records[0].outputSha256=hash(output);
 await writeFile(e.reportPath,JSON.stringify(report));
 await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/truncated chunk|incomplete/);
});
test("rejects PNG files with bytes after IEND",async t=>{
 const e=await setup(t),output=Buffer.concat([pngBytes(20,16),Buffer.from("trailing")]),report=JSON.parse(await readFile(e.reportPath,"utf8"));
 await writeFile(join(e.run,"fixture-portrait.png"),output);
 report.records[0].outputSha256=hash(output);
 await writeFile(e.reportPath,JSON.stringify(report));
 await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/trailing bytes/);
});

function validReviewFixture(fixture) {
 return {fixtureId:fixture.fixtureId,fixtureCategory:fixture.fixtureCategory,inputSha256:fixture.inputSha256,outputSha256:fixture.outputSha256,decision:"reviewed_pass",notes:"Reviewed at fit-to-screen and 100% zoom; no visible defects.",checks:{detailRetention:"acceptable",edgeTextIntegrity:"acceptable",artifactControl:"acceptable",colorToneConsistency:"acceptable",naturalAppearance:"acceptable"}};
}
function validReviewPayload(manifest) {
 return {schemaVersion:1,reviewProtocol:"ev-upscale-rubric-v1",model:manifest.model,reviewer:"Quality Reviewer",exportedAt:"2026-11-09T12:00:00.000Z",humanReviewRequired:true,qualityVerified:false,fixtures:manifest.fixtures.map(validReviewFixture)};
}
function reviewManifest(model="realesrgan-x4plus") {
 return {schemaVersion:1,model,modelVersion:"sha256:pinned",qualityVerified:false,humanReviewRequired:true,fixtures:categories.map(category=>({fixtureId:"fixture-"+category,fixtureCategory:category,inputSha256:"a".repeat(64),outputSha256:"b".repeat(64)}))};
}

test("accepts a complete human review export bound to all five package checksums",()=>{
 const manifest=reviewManifest(),result=validateUpscaleHumanReviewNotes(validReviewPayload(manifest),manifest);
 assert.deepEqual(result,{valid:true,errors:[]});
});
test("rejects duplicate fixture IDs in the review manifest",()=>{
 const manifest=reviewManifest();manifest.fixtures[1].fixtureId=manifest.fixtures[0].fixtureId;
 const result=validateUpscaleHumanReviewNotes(validReviewPayload(manifest),manifest);
 assert.equal(result.valid,false);assert.match(result.errors.join(" "),/fixture IDs must be non-empty and unique/);
});
test("rejects a manifest with duplicate fixture categories",()=>{
 const manifest=reviewManifest();manifest.fixtures[1].fixtureCategory=manifest.fixtures[0].fixtureCategory;
 const result=validateUpscaleHumanReviewNotes(validReviewPayload(manifest),manifest);
 assert.equal(result.valid,false);assert.match(result.errors.join(" "),/each required fixture category exactly once/);
});
test("rejects a manifest with an unsupported schema version",()=>{
 const manifest=reviewManifest();manifest.schemaVersion=2;
 const result=validateUpscaleHumanReviewNotes(validReviewPayload(manifest),manifest);
 assert.equal(result.valid,false);assert.match(result.errors.join(" "),/schema, model or model version is invalid/);
});
test("rejects malformed SHA-256 values even when notes match the manifest",()=>{
 const manifest=reviewManifest(),notes=validReviewPayload(manifest);manifest.fixtures[0].outputSha256="not-a-sha256";notes.fixtures[0].outputSha256="not-a-sha256";
 const result=validateUpscaleHumanReviewNotes(notes,manifest);
 assert.equal(result.valid,false);assert.match(result.errors.join(" "),/valid SHA-256 digests/);
});
test("rejects human review exports whose fixture checksum differs from the package",()=>{
 const manifest=reviewManifest(),notes=validReviewPayload(manifest);notes.fixtures[0].outputSha256="c".repeat(64);
 const result=validateUpscaleHumanReviewNotes(notes,manifest);
 assert.equal(result.valid,false);assert.match(result.errors.join(" "),/checksum does not match/);
});
test("accepts a Fail decision when a reviewer records a visible defect",()=>{
 const manifest=reviewManifest(),notes=validReviewPayload(manifest);notes.fixtures[0].decision="reviewed_fail";notes.fixtures[0].checks.artifactControl="issue";
 const result=validateUpscaleHumanReviewNotes(notes,manifest);
 assert.deepEqual(result,{valid:true,errors:[]});
});
test("rejects a Pass decision when any rubric item reports an issue",()=>{
 const manifest=reviewManifest(),notes=validReviewPayload(manifest);notes.fixtures[0].checks.edgeTextIntegrity="issue";
 const result=validateUpscaleHumanReviewNotes(notes,manifest);
 assert.equal(result.valid,false);assert.match(result.errors.join(" "),/cannot pass/);
});
test("rejects review exports with a timestamp missing its timezone",()=>{
 const manifest=reviewManifest(),notes=validReviewPayload(manifest);notes.exportedAt="2026-11-09T12:00:00";
 const result=validateUpscaleHumanReviewNotes(notes,manifest);
 assert.equal(result.valid,false);assert.match(result.errors.join(" "),/complete ISO date-time with timezone/);
});
test("rejects impossible calendar dates in review timestamps",()=>{
 const manifest=reviewManifest(),notes=validReviewPayload(manifest);notes.exportedAt="2026-99-45T12:00:00.000Z";
 const result=validateUpscaleHumanReviewNotes(notes,manifest);
 assert.equal(result.valid,false);assert.match(result.errors.join(" "),/complete ISO date-time with timezone/);
});
test("rejects review exports with an invalid ISO timestamp",()=>{
 const manifest=reviewManifest(),notes=validReviewPayload(manifest);notes.exportedAt="not-a-date";
 const result=validateUpscaleHumanReviewNotes(notes,manifest);
 assert.equal(result.valid,false);assert.match(result.errors.join(" "),/complete ISO date-time with timezone/);
});
test("rejects review exports that claim quality verification",()=>{
 const manifest=reviewManifest(),notes=validReviewPayload(manifest);notes.qualityVerified=true;
 const result=validateUpscaleHumanReviewNotes(notes,manifest);
 assert.equal(result.valid,false);assert.match(result.errors.join(" "),/qualityVerified must remain false/);
});
test("rejects missing rubric decisions and duplicate fixture entries",()=>{
 const manifest=reviewManifest(),notes=validReviewPayload(manifest);notes.fixtures[0].checks.detailRetention="not_assessed";notes.fixtures[1]=notes.fixtures[0];
 const result=validateUpscaleHumanReviewNotes(notes,manifest);
 assert.equal(result.valid,false);assert.match(result.errors.join(" "),/rubric item must be assessed|cannot repeat/);
});

