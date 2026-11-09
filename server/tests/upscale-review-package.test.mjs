import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,readFile,rm,writeFile,symlink,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createUpscaleReviewPackage } from "../upscale-review-package.mjs";
const categories=["portrait","fine_texture","text","animation","low_light_noisy"];
const hash=b=>createHash("sha256").update(b).digest("hex");
function pngChunk(type,data){const name=Buffer.from(type),body=Buffer.concat([name,data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const checksum=(crc^0xffffffff)>>>0;const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const tail=Buffer.alloc(4);tail.writeUInt32BE(checksum);return Buffer.concat([length,body,tail]);}
function pngBytes(width,height){const signature=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=6;const rows=Buffer.alloc(height*(1+width*4));return Buffer.concat([signature,pngChunk("IHDR",ihdr),pngChunk("IDAT",deflateSync(rows)),pngChunk("IEND",Buffer.alloc(0))]);}

async function setup(t){
 const root=await mkdtemp(join(tmpdir(),"ev-upscale-review-")),fixtures=join(root,"fixtures"),run=join(root,"run");
 await mkdir(fixtures);await mkdir(run);
 const manifest={fixtures:categories.map(c=>({fixtureId:"fixture-"+c,fixtureCategory:c,path:"fixtures/"+c+".png",scale:2}))},records=[];
 for(const f of manifest.fixtures){const input=pngBytes(10,8),output=pngBytes(20,16);await writeFile(join(fixtures,f.fixtureCategory+".png"),input);await writeFile(join(run,f.fixtureId+".png"),output);records.push({fixtureId:f.fixtureId,fixtureCategory:f.fixtureCategory,model:"realesrgan-x4plus",modelVersion:"sha256:pinned",binarySha256:"a".repeat(64),modelFilesSha256:"b".repeat(64),inputSha256:hash(input),outputSha256:hash(output),inputWidth:10,inputHeight:8,outputWidth:20,outputHeight:16,scale:2,durationMs:20,executionStatus:"passed",qualityReview:"not_reviewed",timestamp:"2026-11-09T00:00:00.000Z"});}
 const reportPath=join(root,"report.json"),manifestPath=join(root,"manifest.json"),outputDirectory=join(root,"review");
 await writeFile(reportPath,JSON.stringify({schemaVersion:1,model:"realesrgan-x4plus",modelVersion:"sha256:pinned",generatedAt:"2026-11-09T00:00:00.000Z",records}));await writeFile(manifestPath,JSON.stringify(manifest));t.after(()=>rm(root,{recursive:true,force:true}));return{root,fixtures,run,reportPath,manifestPath,outputDirectory};
}
test("creates a checksum-verified five-fixture human review package",async t=>{const e=await setup(t),r=await createUpscaleReviewPackage({...e,runDirectory:e.run});assert.equal(r.fixtureCount,5);assert.equal(r.qualityVerified,false);const html=await readFile(r.htmlPath,"utf8");assert.match(html,/Human visual assessment/);assert.match(html,/Export review notes JSON/);assert.match(html,/NOT REVIEWED/);assert.match(html,/Reviewer name/);assert.match(html,/data-input-sha256/);assert.match(html,/data-output-sha256/);assert.match(html,/fixtureCategory:card.dataset.category/);assert.match(html,/at least 20 characters/);assert.match(html,/REVIEWED · PASS/);assert.match(html,/setTimeout\(\(\)=>URL\.revokeObjectURL\(url\),60000\)/);const manifest=JSON.parse(await readFile(r.reviewManifestPath,"utf8"));assert.equal(manifest.fixtures.length,5);assert.equal(manifest.qualityVerified,false);const rootInfo=await stat(e.outputDirectory),assetsInfo=await stat(join(e.outputDirectory,"assets")),sourceInfo=await stat(join(e.outputDirectory,"assets","fixture-portrait-source.png")),outputInfo=await stat(join(e.outputDirectory,"assets","fixture-portrait-enhanced.png"));assert.equal(rootInfo.mode&0o777,0o700);assert.equal(assetsInfo.mode&0o777,0o700);assert.equal(sourceInfo.mode&0o777,0o600);assert.equal(outputInfo.mode&0o777,0o600);});
test("rejects changed output bytes before creating a package",async t=>{const e=await setup(t);await writeFile(join(e.run,"fixture-portrait.png"),"tampered");await assert.rejects(createUpscaleReviewPackage({...e,runDirectory:e.run}),/checksum mismatch/);});
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
