import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateUpscaleFixtureManifest } from "./upscale-benchmark-runner.mjs";
import { summarizeUpscaleBenchmarks, validateUpscaleBenchmarkRecord } from "./upscale-benchmark.mjs";

const MODELS = new Set(["realesrgan-x4plus", "realesrgan-x4plus-anime"]);
const MAX_JSON = 4 * 1024 * 1024;
const MAX_IMAGE = 250 * 1024 * 1024;
const fail = message => Object.assign(new Error(message), { code: "AI_UPSCALE_REVIEW_PACKAGE_INVALID" });
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);

async function readJson(path, label) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 2 || info.size > MAX_JSON) throw fail(label + " must be a regular JSON file within 4 MiB.");
    const bytes = await handle.readFile();
    if (bytes.length !== info.size) throw fail(label + " changed while being read.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally { await handle.close().catch(() => {}); }
}

async function fingerprint(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > MAX_IMAGE) throw fail("Review images must be regular non-symlink files within 250 MiB.");
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0) })) {
    bytes += chunk.length;
    if (bytes > MAX_IMAGE) throw fail("Review image exceeded its size limit.");
    digest.update(chunk);
  }
  const after = await lstat(path);
  if (bytes !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw fail("Review image changed while being hashed.");
  return { sha256: digest.digest("hex"), bytes };
}

async function resolveFixture(root, path) {
  if (typeof path !== "string" || !path.trim() || isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw fail("Fixture path must remain relative to the manifest directory.");
  const candidate = resolve(root, path);
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw fail("Fixture images must be regular non-symlink files.");
  const realRoot = await realpath(root), realCandidate = await realpath(candidate);
  const rel = relative(realRoot, realCandidate);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw fail("Fixture path resolves outside the manifest directory.");
  const extension = extname(realCandidate).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) throw fail("Review fixtures must use PNG, JPEG or WebP images.");
  return { path: realCandidate, extension };
}

function renderHtml(model, records) {
  const cards = records.map((r, i) => `<article class="fixture" data-id="${escapeHtml(r.fixtureId)}" data-category="${escapeHtml(r.fixtureCategory)}" data-input-sha256="${escapeHtml(r.inputSha256)}" data-output-sha256="${escapeHtml(r.outputSha256)}">
<header><div><span class="eyebrow">FIXTURE ${String(i + 1).padStart(2,"0")}</span><h2>${escapeHtml(r.fixtureCategory.replace(/_/g," "))}</h2></div><span class="pending">NOT REVIEWED</span></header>
<div class="compare"><img src="assets/${r.fixtureId}-source${r.sourceExtension}" alt="Original source"><div class="enhanced"><img src="assets/${r.fixtureId}-enhanced.png" alt="Enhanced output"></div><span class="divider"></span><span class="tag left">ORIGINAL</span><span class="tag right">ENHANCED</span></div>
<label class="slider-label">Reveal enhanced <output>50%</output><input type="range" min="0" max="100" value="50" aria-label="Compare original and enhanced"></label>
<dl><div><dt>Dimensions</dt><dd>${r.inputWidth} × ${r.inputHeight} → ${r.outputWidth} × ${r.outputHeight}</dd></div><div><dt>Scale / time</dt><dd>${r.scale}× · ${r.durationMs} ms</dd></div><div><dt>Source SHA-256</dt><dd>${r.inputSha256.slice(0,20)}…</dd></div><div><dt>Output SHA-256</dt><dd>${r.outputSha256.slice(0,20)}…</dd></div></dl>
<fieldset><legend>Human visual assessment</legend><label>Decision<select data-decision><option value="pending">Not reviewed</option><option value="reviewed_pass">Pass</option><option value="reviewed_fail">Fail</option></select></label><label>Review notes<textarea data-notes rows="3" minlength="20" placeholder="Describe detail retention, edges/text, artifacts, noise and defects."></textarea></label></fieldset></article>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Executive Visuals · AI Upscale Review</title><style>
:root{color-scheme:dark;font:15px/1.5 system-ui,sans-serif;background:#0b0b12;color:#f3f0fb}*{box-sizing:border-box}body{margin:0 auto;padding:26px;max-width:1120px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.eyebrow{font-size:11px;letter-spacing:1.4px;color:#c4b5fd;font-weight:800}h1{font-size:clamp(24px,4vw,36px);margin:4px 0}h2{font-size:19px;margin:2px 0;text-transform:capitalize}.sub,.footer{color:#b8b2c7}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:end}.reviewer-label{display:grid;gap:4px;font-size:11px;color:#c9c3d4}.reviewer-label input{background:#0e0c15;color:#f3f0fb;border:1px solid #4b435d;border-radius:6px;padding:9px;font:inherit}.reviewed-pass{font-size:10px;font-weight:800;color:#a7f3d0;border:1px solid #276749;border-radius:20px;padding:5px 9px}.reviewed-fail{font-size:10px;font-weight:800;color:#fca5a5;border:1px solid #7f1d1d;border-radius:20px;padding:5px 9px}button{background:#7556bc;color:white;border:1px solid #9c83df;border-radius:8px;padding:10px 14px;font-weight:700;cursor:pointer}.notice{margin:16px 0;padding:12px;border:1px solid #6b5734;background:#241f17;color:#f4d9a8;border-radius:8px}.fixture{border:1px solid #353044;background:#15131e;border-radius:12px;padding:16px;margin:16px 0}.fixture header{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px}.pending{font-size:10px;font-weight:800;color:#f4d9a8;border:1px solid #6b5734;border-radius:20px;padding:5px 9px}.compare{--reveal:50%;position:relative;overflow:hidden;aspect-ratio:16/9;background:#08080d;border:1px solid #40394f;border-radius:8px}.compare>img,.enhanced img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.enhanced{position:absolute;inset:0;overflow:hidden;clip-path:inset(0 calc(100% - var(--reveal)) 0 0)}.divider{position:absolute;top:0;bottom:0;left:var(--reveal);width:2px;background:white}.tag{position:absolute;top:9px;background:#09090dcc;padding:4px 8px;border-radius:5px;font-size:10px;font-weight:800}.left{left:9px}.right{right:9px}.slider-label{display:grid;grid-template-columns:1fr auto;gap:7px;margin:12px 0;color:#d4cde2}.slider-label input{grid-column:1/-1;width:100%;accent-color:#b49aff}.fixture dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:14px 0}.fixture dl div{padding:9px;background:#100e17;border-radius:7px;min-width:0}.fixture dt{font-size:10px;color:#aaa2bb;text-transform:uppercase}.fixture dd{margin:3px 0 0;font-size:12px;overflow-wrap:anywhere}.fixture fieldset{border:1px solid #40394f;border-radius:8px;padding:12px;display:grid;grid-template-columns:180px 1fr;gap:12px}.fixture legend{color:#c4b5fd;font-size:12px;font-weight:800}.fixture fieldset label{display:grid;gap:5px;color:#c9c3d4;font-size:12px}.fixture select,.fixture textarea{width:100%;background:#0e0c15;color:#f3f0fb;border:1px solid #4b435d;border-radius:6px;padding:9px;font:inherit}.fixture textarea{resize:vertical}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #c4b5fd;outline-offset:3px}.footer{font-size:12px}@media(max-width:650px){body{padding:13px}.fixture{padding:11px}.fixture fieldset,.fixture dl{grid-template-columns:1fr}.compare{aspect-ratio:4/3}}
</style></head><body><div class="top"><div><span class="eyebrow">EXECUTIVE VISUALS · HUMAN QUALITY GATE</span><h1>AI Upscale Review</h1><div class="sub">Model: <strong>${escapeHtml(model)}</strong> · Five source/output pairs · Execution evidence only</div></div><div class="actions"><label class="reviewer-label">Reviewer name<input id="reviewer" autocomplete="name" minlength="2" maxlength="120" placeholder="Your name"></label><button id="export">Export review notes JSON</button><button id="reset">Reset decisions</button></div></div>
<div class="notice">This package does not certify quality. Inspect every pair at fit-to-screen and 100% zoom. Check faces, fine texture, text/edges, animation artifacts and low-light noise. Record a decision and substantive notes for every fixture.</div>${cards}
<p class="footer">Exported notes are not yet quality evidence. An authorized reviewer must verify and hash the review artifact and update the private evidence file separately.</p>
<script>
const cards=[...document.querySelectorAll(".fixture")];
function syncDecision(card){const decision=card.querySelector("[data-decision]").value,badge=card.querySelector(".pending,.reviewed-pass,.reviewed-fail");badge.className=decision==="reviewed_pass"?"reviewed-pass":decision==="reviewed_fail"?"reviewed-fail":"pending";badge.textContent=decision==="reviewed_pass"?"REVIEWED · PASS":decision==="reviewed_fail"?"REVIEWED · FAIL":"NOT REVIEWED";}
cards.forEach(card=>{const slider=card.querySelector('input[type="range"]'),output=card.querySelector("output");slider.addEventListener("input",()=>{card.querySelector(".compare").style.setProperty("--reveal",slider.value+"%");output.value=slider.value+"%";});card.querySelector("[data-decision]").addEventListener("change",()=>syncDecision(card));});
document.getElementById("reset").addEventListener("click",()=>{cards.forEach(card=>{card.querySelector("[data-decision]").value="pending";card.querySelector("[data-notes]").value="";syncDecision(card);});document.getElementById("reviewer").value="";});
document.getElementById("export").addEventListener("click",()=>{const reviewer=document.getElementById("reviewer").value.trim();if(reviewer.length<2){alert("Enter the reviewer name before exporting.");return;}const fixtures=cards.map(card=>({fixtureId:card.dataset.id,fixtureCategory:card.dataset.category,inputSha256:card.dataset.inputSha256,outputSha256:card.dataset.outputSha256,decision:card.querySelector("[data-decision]").value,notes:card.querySelector("[data-notes]").value.trim()}));const incomplete=fixtures.filter(item=>item.decision==="pending"||item.notes.length<20);if(incomplete.length){alert("Complete a decision and at least 20 characters of review notes for all five fixtures.");return;}const payload={schemaVersion:1,model:${JSON.stringify(model)},reviewer,exportedAt:new Date().toISOString(),humanReviewRequired:true,qualityVerified:false,fixtures};const blob=new Blob([JSON.stringify(payload,null,2)+"\n"],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="upscale-human-review-notes.json";document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);});
</script></body></html>`;
}

export async function createUpscaleReviewPackage({ reportPath, manifestPath, runDirectory, outputDirectory } = {}) {
  for (const [path,label] of [[reportPath,"Benchmark report"],[manifestPath,"Fixture manifest"],[runDirectory,"Run directory"],[outputDirectory,"Output directory"]]) if (typeof path !== "string" || !path.trim()) throw fail(label + " path is required.");
  const runRoot=resolve(runDirectory),outRoot=resolve(outputDirectory);
  const runInfo=await lstat(runRoot);
  if (!runInfo.isDirectory() || runInfo.isSymbolicLink()) throw fail("Benchmark run path must be a regular directory.");
  const [report,manifest]=await Promise.all([readJson(resolve(reportPath),"Benchmark report"),readJson(resolve(manifestPath),"Fixture manifest")]);
  if (report.schemaVersion!==1 || !MODELS.has(report.model) || !Array.isArray(report.records) || report.records.length!==5) throw fail("Report must contain exactly five records for an allowlisted model.");
  validateUpscaleFixtureManifest(manifest);
  const summary=summarizeUpscaleBenchmarks(report.records);
  if (summary.invalidRecords.length || summary.execution.passed!==5 || summary.records.length!==5) throw fail("Benchmark records are incomplete, invalid or mixed across model artifacts.");
  const root=dirname(await realpath(resolve(manifestPath))),fixtures=new Map(manifest.fixtures.map(f=>[f.fixtureId,f])),prepared=[];
  for (const record of report.records) {
    if (record.model!==report.model || !validateUpscaleBenchmarkRecord(record).valid) throw fail("Every record must be valid and match the report model.");
    const fixture=fixtures.get(record.fixtureId);
    if (!fixture || fixture.fixtureCategory!==record.fixtureCategory) throw fail("Report fixture IDs/categories must match the manifest.");
    const source=await resolveFixture(root,fixture.path),outputPath=join(runRoot,record.fixtureId+".png");
    const [sourceHash,outputHash]=await Promise.all([fingerprint(source.path),fingerprint(outputPath)]);
    if (sourceHash.sha256!==record.inputSha256 || outputHash.sha256!==record.outputSha256) throw fail("Source or output checksum mismatch for "+record.fixtureId+".");
    prepared.push({...record,sourcePath:source.path,outputPath,sourceExtension:source.extension,sourceBytes:sourceHash.bytes,outputBytes:outputHash.bytes});
  }
  if (await lstat(outRoot).then(()=>true).catch(e=>e.code==="ENOENT"?false:Promise.reject(e))) throw fail("Output directory already exists; existing files are never overwritten.");
  await mkdir(outRoot,{recursive:false});
  try {
    const assets=join(outRoot,"assets");await mkdir(assets);
    for (const r of prepared) {
      const sourceDest=join(assets,r.fixtureId+"-source"+r.sourceExtension),outputDest=join(assets,r.fixtureId+"-enhanced.png");
      await copyFile(r.sourcePath,sourceDest,constants.COPYFILE_EXCL);await copyFile(r.outputPath,outputDest,constants.COPYFILE_EXCL);
      const [sourceCopied,outputCopied]=await Promise.all([fingerprint(sourceDest),fingerprint(outputDest)]);
      if (sourceCopied.sha256!==r.inputSha256 || outputCopied.sha256!==r.outputSha256) throw fail("Copied review asset failed checksum verification for "+r.fixtureId+".");
    }
    const reviewManifest={schemaVersion:1,model:report.model,modelVersion:report.modelVersion,benchmarkGeneratedAt:report.generatedAt,qualityVerified:false,humanReviewRequired:true,fixtures:prepared.map(r=>({fixtureId:r.fixtureId,fixtureCategory:r.fixtureCategory,inputSha256:r.inputSha256,outputSha256:r.outputSha256,inputWidth:r.inputWidth,inputHeight:r.inputHeight,outputWidth:r.outputWidth,outputHeight:r.outputHeight,scale:r.scale,durationMs:r.durationMs,sourceBytes:r.sourceBytes,outputBytes:r.outputBytes}))};
    const htmlPath=join(outRoot,"review.html"),manifestOut=join(outRoot,"review-package.json");
    await writeFile(htmlPath,renderHtml(report.model,prepared),{encoding:"utf8",flag:"wx",mode:0o600});
    await writeFile(manifestOut,JSON.stringify(reviewManifest,null,2)+"\n",{encoding:"utf8",flag:"wx",mode:0o600});
    await writeFile(join(outRoot,"README.txt"),"Open review.html in a browser. Review all five pairs at fit-to-screen and 100% zoom. Export the review notes JSON. The exported notes are not quality evidence until verified, hashed and attached to the private evidence record by an authorized reviewer.\n",{encoding:"utf8",flag:"wx",mode:0o600});
    return {htmlPath,reviewManifestPath:manifestOut,fixtureCount:prepared.length,qualityVerified:false};
  } catch(error) { await rm(outRoot,{recursive:true,force:true}).catch(()=>{}); throw error; }
}
