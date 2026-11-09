import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateUpscaleFixtureManifest } from "./upscale-benchmark-runner.mjs";
import { REQUIRED_UPSCALE_FIXTURE_CATEGORIES, summarizeUpscaleBenchmarks, validateUpscaleBenchmarkRecord } from "./upscale-benchmark.mjs";


const MODELS = new Set(["realesrgan-x4plus", "realesrgan-x4plus-anime", "realesr-animevideov3", "realesrnet-x4plus"]);
const MAX_JSON = 4 * 1024 * 1024;
const MAX_IMAGE = 250 * 1024 * 1024;
const fail = message => Object.assign(new Error(message), { code: "AI_UPSCALE_REVIEW_PACKAGE_INVALID" });
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]);

const REVIEW_CHECKS = ["detailRetention", "edgeTextIntegrity", "artifactControl", "colorToneConsistency", "naturalAppearance"];
const REVIEW_VALUES = new Set(["acceptable", "issue", "not_applicable"]);

/**
 * Validate an exported reviewer response against the immutable package manifest.
 * This checks evidence integrity and reviewer protocol compliance; it does not
 * certify visual quality or replace authorized human approval.
 */
export function validateUpscaleHumanReviewNotes(notes, reviewManifest) {
  const errors = [];
  const add = message => errors.push(message);
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) return { valid: false, errors: ["Review notes must be an object."] };
  if (!reviewManifest || typeof reviewManifest !== "object" || Array.isArray(reviewManifest) || !Array.isArray(reviewManifest.fixtures)) return { valid: false, errors: ["A valid review package manifest is required."] };
  if (reviewManifest.schemaVersion !== 1 || !MODELS.has(reviewManifest.model) || typeof reviewManifest.modelVersion !== "string" || !reviewManifest.modelVersion.trim()) add("Review package manifest schema, model or model version is invalid.");
  const manifestIds = new Set();
  const manifestCategories = new Set();
  for (const fixture of reviewManifest.fixtures) {
    if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) { add("Every manifest fixture must be an object."); continue; }
    if (typeof fixture.fixtureId !== "string" || !fixture.fixtureId.trim() || manifestIds.has(fixture.fixtureId)) add("Manifest fixture IDs must be non-empty and unique.");
    else manifestIds.add(fixture.fixtureId);
    if (!REQUIRED_UPSCALE_FIXTURE_CATEGORIES.includes(fixture.fixtureCategory) || manifestCategories.has(fixture.fixtureCategory)) add("Manifest must contain each required fixture category exactly once.");
    else manifestCategories.add(fixture.fixtureCategory);
    if (typeof fixture.inputSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(fixture.inputSha256) || typeof fixture.outputSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(fixture.outputSha256)) add("Manifest fixture source/output checksums must be valid SHA-256 digests.");
  }
  if (manifestCategories.size !== REQUIRED_UPSCALE_FIXTURE_CATEGORIES.length) add("Review package manifest is missing one or more required fixture categories.");
  if (notes.schemaVersion !== 1) add("Unsupported review notes schema version.");
  if (notes.reviewProtocol !== "ev-upscale-rubric-v1") add("Unsupported human review protocol.");
  if (notes.model !== reviewManifest.model || !MODELS.has(notes.model)) add("Review model does not match the package manifest.");
  if (notes.humanReviewRequired !== true || notes.qualityVerified !== false) add("Human review must remain required and qualityVerified must remain false.");
  if (typeof notes.reviewer !== "string" || notes.reviewer.trim().length < 2 || notes.reviewer.trim().length > 120) add("Reviewer name must contain 2 to 120 characters.");
  const exportedAt = typeof notes.exportedAt === "string" ? Date.parse(notes.exportedAt) : NaN;
  if (typeof notes.exportedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(notes.exportedAt) || !Number.isFinite(exportedAt)) add("Review export timestamp must be a complete ISO date-time with timezone.");
  const expected = reviewManifest.fixtures;
  if (expected.length !== 5 || !Array.isArray(notes.fixtures) || notes.fixtures.length !== expected.length) {
    add("Review notes must contain exactly the five fixtures in the package manifest.");
    return { valid: false, errors };
  }
  const expectedById = new Map(expected.map(item => [item.fixtureId, item]));
  const seen = new Set();
  for (const item of notes.fixtures) {
    if (!item || typeof item !== "object" || Array.isArray(item)) { add("Every fixture review must be an object."); continue; }
    const source = expectedById.get(item.fixtureId);
    if (!source || seen.has(item.fixtureId)) { add("Fixture IDs must match the manifest exactly and cannot repeat."); continue; }
    seen.add(item.fixtureId);
    const isSha256 = value => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
    if (!isSha256(source.inputSha256) || !isSha256(source.outputSha256) || !isSha256(item.inputSha256) || !isSha256(item.outputSha256)) add("Fixture source/output checksums must be valid SHA-256 digests: " + item.fixtureId + ".");
    if (item.fixtureCategory !== source.fixtureCategory || item.inputSha256 !== source.inputSha256 || item.outputSha256 !== source.outputSha256) add("Fixture category or source/output checksum does not match the package manifest for " + item.fixtureId + ".");
    if (!["reviewed_pass", "reviewed_fail"].includes(item.decision)) add("Every fixture requires a Pass or Fail decision: " + item.fixtureId + ".");
    if (typeof item.notes !== "string" || item.notes.trim().length < 20 || item.notes.length > 2000) add("Review notes must contain 20 to 2000 characters: " + item.fixtureId + ".");
    if (!item.checks || typeof item.checks !== "object" || Array.isArray(item.checks)) { add("Every fixture requires all five rubric checks: " + item.fixtureId + "."); continue; }
    if (Object.keys(item.checks).length !== REVIEW_CHECKS.length || REVIEW_CHECKS.some(key => !REVIEW_VALUES.has(item.checks[key]))) add("Every rubric item must be assessed: " + item.fixtureId + ".");
    if (item.decision === "reviewed_pass" && REVIEW_CHECKS.some(key => item.checks[key] === "issue")) add("A fixture with a reported issue cannot pass: " + item.fixtureId + ".");
  }
  if (seen.size !== expected.length) add("One or more package fixtures are missing from the review notes.");
  return { valid: errors.length === 0, errors };
}


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

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[n] = value >>> 0;
  }
  return table;
})();

function updatePngCrc(crc, bytes) {
  for (const byte of bytes) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}

async function readExact(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (!result.bytesRead) throw fail("Enhanced output PNG is truncated.");
    read += result.bytesRead;
  }
  return buffer;
}

async function readPngDimensions(path) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 57 || info.size > MAX_IMAGE) throw fail("Enhanced output must be a complete PNG image.");
    const signature = await readExact(handle, 8, 0);
    if (!signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw fail("Enhanced output must have a valid PNG signature.");
    let offset = 8, width = 0, height = 0, chunkIndex = 0, hasIdat = false, hasIend = false;
    let idatEnded = false, hasPlte = false, colorType = -1, bitDepth = 0;
    const knownCritical = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
    while (offset < info.size) {
      if (info.size - offset < 12) throw fail("Enhanced output PNG has a truncated chunk.");
      const chunkHeader = await readExact(handle, 8, offset);
      const length = chunkHeader.readUInt32BE(0);
      const typeBytes = chunkHeader.subarray(4, 8);
      const type = typeBytes.toString("ascii");
      if (length > 0x7fffffff || length > info.size - offset - 12) throw fail("Enhanced output PNG chunk exceeds the file boundary.");
      if (![...typeBytes].every(byte => (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)) ||
          (typeBytes[2] & 0x20) !== 0) throw fail("Enhanced output PNG contains an invalid chunk type.");
      if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) throw fail("Enhanced output PNG must begin with a valid IHDR chunk.");
      if (chunkIndex > 0 && type === "IHDR") throw fail("Enhanced output PNG contains a duplicate IHDR chunk.");
      if (hasIend) throw fail("Enhanced output PNG contains data after IEND.");
      if (hasIdat && type !== "IDAT") idatEnded = true;
      if (type === "IDAT" && idatEnded) throw fail("Enhanced output PNG IDAT chunks must be consecutive.");
      if (type === "PLTE") {
        if (hasPlte || hasIdat || colorType === 0 || colorType === 4 || length < 3 || length > 768 || length % 3 !== 0) {
          throw fail("Enhanced output PNG contains an invalid or misplaced PLTE chunk.");
        }
        if (colorType === 3 && length / 3 > 2 ** bitDepth) throw fail("Enhanced output PNG palette exceeds its indexed bit depth.");
        hasPlte = true;
      }
      if (type === "IEND" && (length !== 0 || !hasIdat)) throw fail("Enhanced output PNG is missing image data or has an invalid IEND chunk.");
      if ((typeBytes[0] & 0x20) === 0 && !knownCritical.has(type)) throw fail("Enhanced output PNG contains an unsupported critical chunk.");

      let crc = updatePngCrc(0xffffffff, typeBytes);
      let dataOffset = offset + 8, remaining = length;
      const ihdr = type === "IHDR" ? Buffer.alloc(13) : null;
      let copied = 0;
      while (remaining > 0) {
        const size = Math.min(64 * 1024, remaining);
        const bytes = await readExact(handle, size, dataOffset);
        crc = updatePngCrc(crc, bytes);
        if (ihdr) { bytes.copy(ihdr, copied); copied += bytes.length; }
        dataOffset += size;
        remaining -= size;
      }
      const expectedCrc = (await readExact(handle, 4, dataOffset)).readUInt32BE(0);
      if (((crc ^ 0xffffffff) >>> 0) !== expectedCrc) throw fail("Enhanced output PNG contains an invalid chunk checksum.");
      if (type === "IHDR") {
        width = ihdr.readUInt32BE(0);
        height = ihdr.readUInt32BE(4);
        bitDepth = ihdr[8]; colorType = ihdr[9];
        const compression = ihdr[10], filter = ihdr[11], interlace = ihdr[12];
        const validDepths = ({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]})[colorType] || [];
        if (!width || !height || width > 0x7fffffff || height > 0x7fffffff ||
            !validDepths.includes(bitDepth) || compression !== 0 || filter !== 0 || ![0,1].includes(interlace)) {
          throw fail("Enhanced output PNG dimensions or IHDR fields are invalid.");
        }
      }
      if (type === "IDAT") hasIdat = true;
      if (type === "IEND") {
        if (colorType === 3 && !hasPlte) throw fail("Enhanced output indexed PNG is missing its required PLTE chunk.");
        hasIend = true;
        if (dataOffset + 4 !== info.size) throw fail("Enhanced output PNG contains trailing bytes after IEND.");
      }
      offset = dataOffset + 4;
      chunkIndex++;
    }
    if (!hasIend || !hasIdat || offset !== info.size) throw fail("Enhanced output PNG is incomplete.");
    return { width, height };
  } finally { await handle.close().catch(() => {}); }
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
<div class="compare"><img src="assets/${r.fixtureId}-source${r.sourceExtension}" alt="Original source"><div class="enhanced"><img src="assets/${r.fixtureId}-enhanced.png" alt="Enhanced output"></div><span class="divider"></span><span class="tag left">ORIGINAL</span><span class="tag right">ENHANCED</span><div class="zoom-actions"><button type="button" data-zoom="source">Source · 100%</button><button type="button" data-zoom="enhanced">Enhanced · 100%</button></div></div>
<label class="slider-label">Reveal enhanced <output>50%</output><input type="range" min="0" max="100" value="50" aria-label="Compare original and enhanced"></label>
<dl><div><dt>Dimensions</dt><dd>${r.inputWidth} × ${r.inputHeight} → ${r.outputWidth} × ${r.outputHeight}</dd></div><div><dt>Scale / time</dt><dd>${r.scale}× · ${r.durationMs} ms</dd></div><div><dt>Tile execution</dt><dd>Requested ${r.requestedTile ?? "not recorded"} → actual ${r.tile ?? "not recorded"} · fallback ${r.tileFallbackUsed === true ? "used" : r.tileFallbackUsed === false ? "not used" : "not recorded"}</dd></div><div><dt>Tile attempts</dt><dd>${escapeHtml(Array.isArray(r.tileAttempts) ? r.tileAttempts.join(" → ") : "not recorded")}</dd></div><div><dt>Source SHA-256</dt><dd>${r.inputSha256.slice(0,20)}…</dd></div><div><dt>Output SHA-256</dt><dd>${r.outputSha256.slice(0,20)}…</dd></div></dl>
<fieldset><legend>Human visual assessment</legend><label>Decision<select data-decision><option value="pending">Not reviewed</option><option value="reviewed_pass">Pass</option><option value="reviewed_fail">Fail</option></select></label><label>Review notes<textarea data-notes rows="3" minlength="20" maxlength="2000" placeholder="Describe detail retention, edges/text, artifacts, noise and defects."></textarea></label></fieldset><fieldset class="rubric"><legend>Required quality rubric</legend>${[["detailRetention","Detail retention"],["edgeTextIntegrity","Edges and text integrity"],["artifactControl","Halos, ringing and artifacts"],["colorToneConsistency","Color and tonal consistency"],["naturalAppearance","Natural appearance"]].map(([key,label])=>`<label>${label}<select data-check="${key}"><option value="not_assessed">Not assessed</option><option value="acceptable">Acceptable</option><option value="issue">Issue found</option><option value="not_applicable">Not applicable</option></select></label>`).join("")}</fieldset></article>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Executive Visuals · AI Upscale Review</title><style>
:root{color-scheme:dark;font:15px/1.5 system-ui,sans-serif;background:#0b0b12;color:#f3f0fb}*{box-sizing:border-box}body{margin:0 auto;padding:26px;max-width:1120px}.top{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.eyebrow{font-size:11px;letter-spacing:1.4px;color:#c4b5fd;font-weight:800}h1{font-size:clamp(24px,4vw,36px);margin:4px 0}h2{font-size:19px;margin:2px 0;text-transform:capitalize}.sub,.footer{color:#b8b2c7}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:end}.reviewer-label{display:grid;gap:4px;font-size:11px;color:#c9c3d4}.reviewer-label input{background:#0e0c15;color:#f3f0fb;border:1px solid #4b435d;border-radius:6px;padding:9px;font:inherit}.reviewed-pass{font-size:10px;font-weight:800;color:#a7f3d0;border:1px solid #276749;border-radius:20px;padding:5px 9px}.reviewed-fail{font-size:10px;font-weight:800;color:#fca5a5;border:1px solid #7f1d1d;border-radius:20px;padding:5px 9px}button{background:#7556bc;color:white;border:1px solid #9c83df;border-radius:8px;padding:10px 14px;font-weight:700;cursor:pointer}.notice{margin:16px 0;padding:12px;border:1px solid #6b5734;background:#241f17;color:#f4d9a8;border-radius:8px}.fixture[hidden]{display:none!important}.review-tools{display:grid;grid-template-columns:minmax(180px,1fr) minmax(180px,2fr) auto;gap:10px;align-items:end;margin:14px 0;padding:12px;border:1px solid #40394f;background:#15131e;border-radius:10px}.review-tools label{display:grid;gap:5px;color:#c9c3d4;font-size:12px}.review-tools select,.review-tools input{width:100%;background:#0e0c15;color:#f3f0fb;border:1px solid #4b435d;border-radius:6px;padding:9px;font:inherit}.review-tools output{font-size:12px;color:#c4b5fd;white-space:nowrap}.review-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;padding:13px;border:1px solid #40394f;background:#15131e;border-radius:10px;margin:14px 0}.review-summary>div:not(.progress-track){display:grid;gap:2px}.review-summary span{font-size:11px;color:#aaa2bb}.review-summary strong{font-size:20px;font-variant-numeric:tabular-nums}.progress-track{grid-column:1/-1;height:8px;border-radius:99px;background:#302a3d;overflow:hidden}.progress-track span{display:block;height:100%;width:0;background:#a78bfa;transition:width .18s ease}.fixture{border:1px solid #353044;background:#15131e;border-radius:12px;padding:16px;margin:16px 0}.fixture header{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px}.pending{font-size:10px;font-weight:800;color:#f4d9a8;border:1px solid #6b5734;border-radius:20px;padding:5px 9px}.compare{--reveal:50%;position:relative;overflow:hidden;aspect-ratio:16/9;background:#08080d;border:1px solid #40394f;border-radius:8px}.compare>img,.enhanced img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.enhanced{position:absolute;inset:0;overflow:hidden;clip-path:inset(0 calc(100% - var(--reveal)) 0 0)}.divider{position:absolute;top:0;bottom:0;left:var(--reveal);width:2px;background:white}.tag{position:absolute;top:9px;background:#09090dcc;padding:4px 8px;border-radius:5px;font-size:10px;font-weight:800}.left{left:9px}.right{right:9px}.zoom-actions{position:absolute;bottom:10px;left:10px;display:flex;gap:7px;flex-wrap:wrap}.zoom-actions button{font-size:10px;padding:7px 9px;background:#211a31dd;border-color:#9c83df}#zoom-dialog{padding:12px;border:1px solid #655681;border-radius:12px;background:#100e17;color:#f3f0fb;max-width:98vw;max-height:96vh}#zoom-dialog::backdrop{background:#05040bdc}.zoom-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding-bottom:10px}.zoom-stage{max-width:96vw;max-height:88vh;overflow:auto;background:#08080d;border:1px solid #40394f;border-radius:7px}.zoom-stage img{display:block;width:auto;height:auto;max-width:none;max-height:none}.slider-label{display:grid;grid-template-columns:1fr auto;gap:7px;margin:12px 0;color:#d4cde2}.slider-label input{grid-column:1/-1;width:100%;accent-color:#b49aff}.fixture dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:14px 0}.fixture dl div{padding:9px;background:#100e17;border-radius:7px;min-width:0}.fixture dt{font-size:10px;color:#aaa2bb;text-transform:uppercase}.fixture dd{margin:3px 0 0;font-size:12px;overflow-wrap:anywhere}.fixture fieldset{border:1px solid #40394f;border-radius:8px;padding:12px;display:grid;grid-template-columns:180px 1fr;gap:12px}.fixture fieldset.rubric{grid-template-columns:repeat(2,minmax(0,1fr));margin-top:10px}.fixture legend{color:#c4b5fd;font-size:12px;font-weight:800}.fixture fieldset label{display:grid;gap:5px;color:#c9c3d4;font-size:12px}.fixture select,.fixture textarea{width:100%;background:#0e0c15;color:#f3f0fb;border:1px solid #4b435d;border-radius:6px;padding:9px;font:inherit}.fixture textarea{resize:vertical}button:disabled{opacity:.45;cursor:not-allowed;filter:saturate(.5)}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #c4b5fd;outline-offset:3px}.footer{font-size:12px}@media(max-width:650px){body{padding:13px}.review-tools{grid-template-columns:1fr}.review-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.fixture{padding:11px}.fixture fieldset,.fixture dl{grid-template-columns:1fr}.compare{aspect-ratio:4/3}}
</style></head><body><div class="top"><div><span class="eyebrow">EXECUTIVE VISUALS · HUMAN QUALITY GATE</span><h1>AI Upscale Review</h1><div class="sub">Model: <strong>${escapeHtml(model)}</strong> · Five source/output pairs · Execution evidence only</div></div><div class="actions"><label class="reviewer-label">Reviewer name<input id="reviewer" autocomplete="name" minlength="2" maxlength="120" placeholder="Your name"></label><button id="export" disabled aria-describedby="export-readiness">Export review notes JSON</button><span id="export-readiness" class="footer" role="status" aria-live="polite">Complete all five reviews and enter your reviewer name to enable export.</span><button id="reset">Reset decisions</button></div></div>
<div class="notice">This package does not certify quality. Inspect every pair at fit-to-screen and 100% zoom. Check faces, fine texture, text/edges, animation artifacts and low-light noise. Complete every rubric item and record substantive notes. A pass cannot contain a reported issue. Metric scores must not override visual review.</div><section class="review-summary" aria-label="Review progress" aria-live="polite"><div><span>Reviewed</span><strong id="reviewed-count">0 / 5</strong></div><div><span>Pass</span><strong id="pass-count">0</strong></div><div><span>Fail</span><strong id="fail-count">0</strong></div><div><span>Rubric items</span><strong id="rubric-count">0 / 25</strong></div><div class="progress-track" role="progressbar" aria-label="Reviewed fixtures" aria-valuemin="0" aria-valuemax="5" aria-valuenow="0"><span id="review-progress"></span></div></section><section class="review-tools" aria-label="Filter review fixtures"><label for="review-filter">Review status<select id="review-filter"><option value="all">All fixtures</option><option value="incomplete">Needs attention</option><option value="pass">Completed pass</option><option value="fail">Completed fail</option></select></label><label for="review-search">Find fixture<input id="review-search" type="search" placeholder="Search category or fixture ID"></label><output id="visible-fixtures" aria-live="polite">Showing 5 of 5 fixtures</output></section>${cards}
<dialog id="zoom-dialog" aria-label="100 percent image inspection"><div class="zoom-head"><strong id="zoom-title">Image inspection</strong><button type="button" id="zoom-close">Close</button></div><div class="zoom-stage"><img id="zoom-image" alt=""></div></dialog><p class="footer">Exported notes are not yet quality evidence. An authorized reviewer must verify and hash the review artifact and update the private evidence file separately.</p>
<script>
const cards=[...document.querySelectorAll(".fixture")];
function isReviewComplete(card){const decision=card.querySelector("[data-decision]").value,notes=card.querySelector("[data-notes]").value.trim(),checks=[...card.querySelectorAll("[data-check]")],assessed=checks.length===5&&checks.every(control=>["acceptable","issue","not_applicable"].includes(control.value)),passHasIssue=decision==="reviewed_pass"&&checks.some(control=>control.value==="issue");return decision!=="pending"&&notes.length>=20&&assessed&&!passHasIssue;}
function updateSummary(){const completed=cards.filter(isReviewComplete),reviewed=completed.length,passed=completed.filter(card=>card.querySelector("[data-decision]").value==="reviewed_pass").length,failed=completed.filter(card=>card.querySelector("[data-decision]").value==="reviewed_fail").length,rubric=[...document.querySelectorAll("[data-check]")],complete=rubric.filter(control=>["acceptable","issue","not_applicable"].includes(control.value)).length;document.getElementById("reviewed-count").textContent=reviewed+" / "+cards.length;document.getElementById("pass-count").textContent=String(passed);document.getElementById("fail-count").textContent=String(failed);document.getElementById("rubric-count").textContent=complete+" / "+rubric.length;const bar=document.querySelector(".progress-track");bar.setAttribute("aria-valuenow",String(reviewed));document.getElementById("review-progress").style.width=(cards.length?reviewed/cards.length*100:0)+"%";const reviewer=document.getElementById("reviewer").value.trim(),ready=reviewed===cards.length&&reviewer.length>=2&&reviewer.length<=120;document.getElementById("export").disabled=!ready;document.getElementById("export-readiness").textContent=ready?"All five reviews are complete. Export is ready.":"Complete all five reviews and enter your reviewer name to enable export.";}
function filterFixtures(){const status=document.getElementById("review-filter").value,query=document.getElementById("review-search").value.trim().toLowerCase();let visible=0;for(const card of cards){const decision=card.querySelector("[data-decision]").value,complete=isReviewComplete(card),matchesStatus=status==="all"||(status==="incomplete"&&!complete)||(status==="pass"&&complete&&decision==="reviewed_pass")||(status==="fail"&&complete&&decision==="reviewed_fail"),haystack=(card.dataset.id+" "+card.dataset.category+" "+card.querySelector("h2").textContent).toLowerCase(),matchesQuery=!query||haystack.includes(query),show=matchesStatus&&matchesQuery;card.hidden=!show;if(show)visible++;}document.getElementById("visible-fixtures").textContent="Showing "+visible+" of "+cards.length+" fixtures";}
function syncDecision(card){const decision=card.querySelector("[data-decision]").value,complete=isReviewComplete(card),badge=card.querySelector(".pending,.reviewed-pass,.reviewed-fail");badge.className=complete?(decision==="reviewed_pass"?"reviewed-pass":"reviewed-fail"):"pending";badge.textContent=!complete?(decision==="pending"?"NOT REVIEWED":"INCOMPLETE · REVIEW"):decision==="reviewed_pass"?"REVIEWED · PASS":"REVIEWED · FAIL";}
cards.forEach(card=>{const slider=card.querySelector('input[type="range"]'),output=card.querySelector("output");slider.addEventListener("input",()=>{card.querySelector(".compare").style.setProperty("--reveal",slider.value+"%");output.value=slider.value+"%";});card.querySelector("[data-decision]").addEventListener("change",()=>{syncDecision(card);updateSummary();});card.querySelectorAll("[data-check]").forEach(control=>control.addEventListener("change",()=>{syncDecision(card);updateSummary();filterFixtures();}));card.querySelector("[data-notes]").addEventListener("input",()=>{syncDecision(card);updateSummary();filterFixtures();});card.querySelector("[data-decision]").addEventListener("change",filterFixtures);card.querySelectorAll("[data-zoom]").forEach(button=>button.addEventListener("click",()=>{const kind=button.dataset.zoom,image=card.querySelector(kind==="source"?".compare > img":".enhanced img"),dialog=document.getElementById("zoom-dialog"),zoom=document.getElementById("zoom-image");zoom.src=image.currentSrc||image.src;zoom.alt=kind==="source"?"Original source image at 100 percent":"Enhanced output image at 100 percent";document.getElementById("zoom-title").textContent=card.querySelector("h2").textContent+" · "+(kind==="source"?"Original":"Enhanced")+" · 100%";dialog.showModal();}));});updateSummary();document.getElementById("reviewer").addEventListener("input",updateSummary);document.getElementById("review-filter").addEventListener("change",filterFixtures);document.getElementById("review-search").addEventListener("input",filterFixtures);filterFixtures();document.getElementById("zoom-close").addEventListener("click",()=>document.getElementById("zoom-dialog").close());document.getElementById("zoom-dialog").addEventListener("click",event=>{if(event.target===event.currentTarget)event.currentTarget.close();});
document.getElementById("reset").addEventListener("click",()=>{cards.forEach(card=>{card.querySelector("[data-decision]").value="pending";card.querySelector("[data-notes]").value="";card.querySelectorAll("[data-check]").forEach(control=>{control.value="not_assessed";});const slider=card.querySelector('input[type="range"]');slider.value="50";card.querySelector(".compare").style.setProperty("--reveal","50%");card.querySelector("output").value="50%";syncDecision(card);});document.getElementById("reviewer").value="";document.getElementById("review-filter").value="all";document.getElementById("review-search").value="";updateSummary();filterFixtures();});
document.getElementById("export").addEventListener("click",()=>{const reviewer=document.getElementById("reviewer").value.trim();if(reviewer.length<2){alert("Enter the reviewer name before exporting.");return;}const fixtures=cards.map(card=>({fixtureId:card.dataset.id,fixtureCategory:card.dataset.category,inputSha256:card.dataset.inputSha256,outputSha256:card.dataset.outputSha256,decision:card.querySelector("[data-decision]").value,notes:card.querySelector("[data-notes]").value.trim(),checks:Object.fromEntries([...card.querySelectorAll("[data-check]")].map(control=>[control.dataset.check,control.value]))}));const complete=["detailRetention","edgeTextIntegrity","artifactControl","colorToneConsistency","naturalAppearance"];const incomplete=fixtures.filter(item=>item.decision==="pending"||item.notes.length<20||complete.some(key=>!["acceptable","issue","not_applicable"].includes(item.checks[key])));if(incomplete.length){alert("Complete every quality-rubric item, a decision and at least 20 characters of notes for all five fixtures.");return;}const invalidPass=fixtures.filter(item=>item.decision==="reviewed_pass"&&Object.values(item.checks).includes("issue"));if(invalidPass.length){alert("A fixture with a reported quality issue cannot be marked Pass. Change its decision to Fail or resolve the issue.");return;}const payload={schemaVersion:1,reviewProtocol:"ev-upscale-rubric-v1",model:${JSON.stringify(model)},reviewer,exportedAt:new Date().toISOString(),humanReviewRequired:true,qualityVerified:false,fixtures};const blob=new Blob([JSON.stringify(payload,null,2)+"\n"],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="upscale-human-review-notes.json";document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);});
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
    const [sourceHash,outputHash,outputDimensions]=await Promise.all([fingerprint(source.path),fingerprint(outputPath),readPngDimensions(outputPath)]);
    if (sourceHash.sha256!==record.inputSha256 || outputHash.sha256!==record.outputSha256) throw fail("Source or output checksum mismatch for "+record.fixtureId+".");
    if (outputDimensions.width!==record.outputWidth || outputDimensions.height!==record.outputHeight) throw fail("Enhanced PNG dimensions do not match the benchmark record for "+record.fixtureId+".");
    prepared.push({...record,sourcePath:source.path,outputPath,sourceExtension:source.extension,sourceBytes:sourceHash.bytes,outputBytes:outputHash.bytes});
  }
  if (await lstat(outRoot).then(()=>true).catch(e=>e.code==="ENOENT"?false:Promise.reject(e))) throw fail("Output directory already exists; existing files are never overwritten.");
  await mkdir(outRoot,{recursive:false,mode:0o700});
  try {
    const assets=join(outRoot,"assets");await mkdir(assets,{mode:0o700});
    for (const r of prepared) {
      const sourceDest=join(assets,r.fixtureId+"-source"+r.sourceExtension),outputDest=join(assets,r.fixtureId+"-enhanced.png");
      await copyFile(r.sourcePath,sourceDest,constants.COPYFILE_EXCL);await copyFile(r.outputPath,outputDest,constants.COPYFILE_EXCL);await chmod(sourceDest,0o600);await chmod(outputDest,0o600);
      const [sourceCopied,outputCopied]=await Promise.all([fingerprint(sourceDest),fingerprint(outputDest)]);
      if (sourceCopied.sha256!==r.inputSha256 || outputCopied.sha256!==r.outputSha256) throw fail("Copied review asset failed checksum verification for "+r.fixtureId+".");
    }
    const reviewManifest={schemaVersion:1,model:report.model,modelVersion:report.modelVersion,benchmarkGeneratedAt:report.generatedAt,qualityVerified:false,humanReviewRequired:true,fixtures:prepared.map(r=>({fixtureId:r.fixtureId,fixtureCategory:r.fixtureCategory,inputSha256:r.inputSha256,outputSha256:r.outputSha256,inputWidth:r.inputWidth,inputHeight:r.inputHeight,outputWidth:r.outputWidth,outputHeight:r.outputHeight,scale:r.scale,durationMs:r.durationMs,requestedTile:r.requestedTile ?? null,tile:r.tile ?? null,tileFallbackUsed:r.tileFallbackUsed ?? null,tileAttempts:Array.isArray(r.tileAttempts)?r.tileAttempts:[],sourceBytes:r.sourceBytes,outputBytes:r.outputBytes}))};
    const htmlPath=join(outRoot,"review.html"),manifestOut=join(outRoot,"review-package.json");
    await writeFile(htmlPath,renderHtml(report.model,prepared),{encoding:"utf8",flag:"wx",mode:0o600});
    await writeFile(manifestOut,JSON.stringify(reviewManifest,null,2)+"\n",{encoding:"utf8",flag:"wx",mode:0o600});
    await writeFile(join(outRoot,"README.txt"),"Open review.html in a browser. Review all five pairs at fit-to-screen and 100% zoom. Export the review notes JSON. The exported notes are not quality evidence until verified, hashed and attached to the private evidence record by an authorized reviewer.\n",{encoding:"utf8",flag:"wx",mode:0o600});
    return {htmlPath,reviewManifestPath:manifestOut,fixtureCount:prepared.length,qualityVerified:false};
  } catch(error) { await rm(outRoot,{recursive:true,force:true}).catch(()=>{}); throw error; }
}
