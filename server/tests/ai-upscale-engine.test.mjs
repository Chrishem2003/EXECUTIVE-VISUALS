import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { createRealEsrganAdapter } from "../ai-upscale-engine.mjs";

function pngChunk(type, data) {
  const name = Buffer.from(type), body = Buffer.concat([name, data]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, tail]);
}

function pngBytes(width, height, colorType = 6, options = {}) {
  const compress = typeof deflateSync === "function" ? deflateSync : require("node:zlib").deflateSync;
  function chunk(type, data) {
    const name = Buffer.from(type), body = Buffer.concat([name, data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4); tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, tail]);
  }
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colorType; ihdr[12] = options.interlace || 0;
  const interlacePasses = [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]];
  const scanlineBytes = options.interlace === 1
    ? interlacePasses.reduce((total,[x,y,dx,dy]) => {
        const passWidth = width > x ? Math.ceil((width-x)/dx) : 0;
        const passHeight = height > y ? Math.ceil((height-y)/dy) : 0;
        return total + (passWidth && passHeight ? passHeight * (1 + Math.ceil(passWidth * bytesPerPixel)) : 0);
      }, 0)
    : height * (1 + width * bytesPerPixel);
  const scanlines = Buffer.alloc(scanlineBytes);
  if (options.filter !== undefined) scanlines[0] = options.filter;
  const compressed = options.compressedData || compress(scanlines);
  const idat = options.splitIdat ? [compressed.subarray(0, Math.max(1, Math.floor(compressed.length / 2))), compressed.subarray(Math.max(1, Math.floor(compressed.length / 2)))] : [compressed];
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), ...idat.map(data => chunk("IDAT", data)), chunk("IEND", Buffer.alloc(0))]);
}

function pngHeader(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes,0);
  bytes.writeUInt32BE(13,8);
  bytes.write("IHDR",12,"ascii");
  bytes.writeUInt32BE(width,16);
  bytes.writeUInt32BE(height,20);
  return bytes;
}

async function writeFakeEngine(path, fixedDimension = null, outputColorType = 6, sourceDimensions = null, delayMs = 0, pngOptions = {}) {
  const sizeExpression = fixedDimension === null ? "requestedScale" : String(fixedDimension);
  const dimensionsExpression = JSON.stringify(sourceDimensions);
  const safePngOptions = { ...pngOptions };
  const compressedExpression = Buffer.isBuffer(safePngOptions.compressedData)
    ? `Buffer.from(${JSON.stringify([...safePngOptions.compressedData])})`
    : null;
  delete safePngOptions.compressedData;
  const pngOptionsExpression = compressedExpression
    ? `Object.assign(${JSON.stringify(safePngOptions)}, { compressedData: ${compressedExpression} })`
    : JSON.stringify(safePngOptions);
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const { deflateSync } = require("node:zlib");
const args = process.argv.slice(2);
const out = args[args.indexOf("-o") + 1];
const requestedScale = Number(args[args.indexOf("-s") + 1] || 2);
const size = ${sizeExpression};
const sourceDimensions = ${dimensionsExpression};
const width = sourceDimensions ? sourceDimensions[0] * requestedScale : size;
const height = sourceDimensions ? sourceDimensions[1] * requestedScale : size;
${pngBytes.toString()}
fs.writeFileSync(out,pngBytes(width,height,${outputColorType},${pngOptionsExpression}));
`;
  await writeFile(path, source);
  await chmod(path, 0o755);
}

test("AI upscaler is fail-closed when binary and model weights are absent", async () => {
  const adapter = createRealEsrganAdapter({ binaryPath: "/missing/realesrgan", modelDirectory: "/missing/models" });
  const status = await adapter.probe();
  assert.equal(status.available, false);
  assert.equal(status.executionEnabled, false);
  await assert.rejects(adapter.execute({ inputPath: "/missing/input.png", outputPath: "/tmp/out.png" }), error => error.code === "AI_UPSCALE_ENGINE_UNAVAILABLE");
});

test("AI upscaler validates model, scale, tile and distinct paths before execution", () => {
  const adapter = createRealEsrganAdapter({ binaryPath: "/bin/true", modelDirectory: "/tmp" });
  assert.throws(() => adapter.plan({ inputPath: "/tmp/a.png", outputPath: "/tmp/b.png", model: "../../bad" }), error => error.code === "AI_UPSCALE_INVALID_MODEL");
  assert.throws(() => adapter.plan({ inputPath: "/tmp/a.png", outputPath: "/tmp/b.png", scale: 5 }), error => error.code === "AI_UPSCALE_INVALID_OPTIONS");
  assert.throws(() => adapter.plan({ inputPath: "/tmp/a.png", outputPath: "/tmp/a.png" }), error => error.code === "AI_UPSCALE_INVALID_PATH");
});

test("AI upscale model names match the supported NCNN model catalog", () => {
  const adapter = createRealEsrganAdapter({ binaryPath: "/bin/true", modelDirectory: "/tmp" });
  for (const model of ["realesrgan-x4plus", "realesrgan-x4plus-anime", "realesr-animevideov3", "realesrnet-x4plus"]) {
    assert.equal(adapter.plan({ inputPath: "/tmp/input.png", outputPath: "/tmp/output.png", model }).model, model);
  }
  assert.throws(
    () => adapter.plan({ inputPath: "/tmp/input.png", outputPath: "/tmp/output.png", model: "realesrgan-x2plus" }),
    error => error.code === "AI_UPSCALE_INVALID_MODEL"
  );
});

test("AI upscaler launches without a shell and publishes only a new bounded output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const output = join(directory, "enhanced.png");
  await writeFile(input, pngHeader(1,1));
  await writeFakeEngine(binary);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    const result = await adapter.execute({ inputPath: input, outputPath: output, model, scale: 4, tile: 128, format: "png" });
    assert.equal(result.method, "ai-super-resolution");
    assert.ok(result.byteSize >= 24);
    assert.equal(result.model, model);
    await assert.rejects(adapter.execute({ inputPath: input, outputPath: output, model }), error => error.code === "AI_UPSCALE_OUTPUT_EXISTS");
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("AI upscaler rejects a source replaced during inference and removes its derivative", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-source-race-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const output = join(directory, "must-be-removed.png");
  await writeFile(input, pngHeader(1, 1));
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const out = args[args.indexOf("-o") + 1];
${pngBytes.toString()}
fs.writeFileSync(${JSON.stringify(input)}, "replacement bytes");
fs.writeFileSync(out,pngBytes(2,2));
`;
  await writeFile(binary, script);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(
      adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, format: "png" }),
      error => error.code === "AI_UPSCALE_INPUT_CHANGED"
    );
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AI upscaler reports execution checks separately from unverified inference quality", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-selftest-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "fixture.png");
  await writeFile(input, pngHeader(1,1));
  await writeFakeEngine(binary);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    const before = await adapter.probe(model);
    assert.equal(before.executionVerified, false);
    assert.equal(before.inferenceVerified, false);
    const result = await adapter.selfTest({ inputPath: input, model, scale: 2 });
    assert.equal(result.passed, true);
    assert.equal(result.executionVerified, true);
    assert.equal(result.inferenceVerified, false);
    const after = await adapter.probe(model);
    assert.equal(after.executionVerified, true);
    assert.equal(after.inferenceVerified, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("AI upscale self-test becomes stale when model bytes change even if size and mtime are preserved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-selftest-fingerprint-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "fixture.png");
  const weights = join(directory, model + ".bin");
  await writeFile(input, pngHeader(1, 1));
  await writeFakeEngine(binary);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(weights, "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    const selfTest = await adapter.selfTest({ inputPath: input, model, scale: 2 });
    assert.equal(selfTest.executionVerified, true);
    assert.equal((await adapter.probe(model)).executionVerified, true);

    const { stat, utimes } = await import("node:fs/promises");
    const before = await stat(weights);
    const preservedMtimeSecond = Math.floor(before.mtimeMs / 1000);
    await new Promise(resolve => setTimeout(resolve, 15));
    await writeFile(weights, "WEIGHTS"); // Same byte length, different content.
    await utimes(weights, before.atime, preservedMtimeSecond); // Restore a known, exact timestamp.
    const after = await stat(weights);
    assert.equal(after.size, before.size);
    assert.equal(Math.floor(after.mtimeMs / 1000), preservedMtimeSecond);
    assert.notEqual(after.ctimeMs, before.ctimeMs);
    assert.equal((await adapter.probe(model)).executionVerified, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI upscaler rejects an executable that exits successfully but emits a corrupt image", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-corrupt-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const output = join(directory, "corrupt.png");
  await writeFile(input, pngHeader(1,1));
  await writeFile(binary, String.raw`#!/bin/sh
while [ "$1" != "" ]; do
  if [ "$1" = "-o" ]; then shift; printf 'not-an-image-output' > "$1"; fi
  shift
done
`);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(
      adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, format: "png" }),
      error => error.code === "AI_UPSCALE_OUTPUT_INVALID"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI upscaler rejects malformed source image headers before launching the engine", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-invalid-source-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const output = join(directory, "output.png");
  await writeFile(input, Buffer.from([137,80,78,71,13,10,26,10]));
  await writeFakeEngine(binary);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(
      adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, format: "png" }),
      error => error.code === "AI_UPSCALE_IMAGE_DIMENSIONS_INVALID"
    );
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI upscaler rejects valid image files whose dimensions do not match the requested scale", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-dimensions-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const output = join(directory, "wrong-size.png");
  await writeFile(input, pngHeader(8, 6));
  await writeFakeEngine(binary, 1);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(
      adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, format: "png" }),
      error => error.code === "AI_UPSCALE_OUTPUT_DIMENSIONS_MISMATCH"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI upscaler does not overwrite a symbolic-link output target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-link-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const protectedFile = join(directory, "protected.png");
  const output = join(directory, "linked-output.png");
  await writeFile(input, pngHeader(1,1));
  await writeFile(protectedFile, "preserve-this-file");
  await writeFile(binary, String.raw`#!/bin/sh
exit 0
`);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const { symlink } = await import("node:fs/promises");
    await symlink(protectedFile, output);
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(
      adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, format: "png" }),
      error => error.code === "AI_UPSCALE_OUTPUT_EXISTS"
    );
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(protectedFile, "utf8"), "preserve-this-file");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("AI upscaler retries recognized GPU-memory failures with smaller automatic tiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-vram-fallback-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const output = join(directory, "enhanced.png");
  const attemptsFile = join(directory, "attempts.txt");
  await writeFile(input, pngHeader(8, 6));
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = key => args[args.indexOf(key) + 1];
const tile = Number(value("-t"));
const input = fs.readFileSync(value("-i"));
const output = value("-o");
const scale = Number(value("-s"));
${pngBytes.toString()}
const attemptsFile = ${JSON.stringify(attemptsFile)};
const previous = fs.existsSync(attemptsFile) ? Number(fs.readFileSync(attemptsFile, "utf8")) : 0;
fs.writeFileSync(attemptsFile, String(previous + 1));
if (tile === 0 || tile === 256) {
  fs.writeFileSync(output, "partial-output");
  process.stderr.write("vkAllocateMemory failed: VK_ERROR_OUT_OF_DEVICE_MEMORY");
  process.exit(2);
}
fs.writeFileSync(output, pngBytes(input.readUInt32BE(16) * scale, input.readUInt32BE(20) * scale));
`;
  await writeFile(binary, source);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    const result = await adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, tile: 0, format: "png" });
    assert.equal(result.tile, 192);
    assert.equal(result.requestedTile, 0);
    assert.equal(result.tileFallbackUsed, true);
    assert.deepEqual(result.tileAttempts, [0, 256, 192]);
    assert.deepEqual(result.outputDimensions, { width: 16, height: 12 });
    assert.equal(Number(await import("node:fs/promises").then(fs => fs.readFile(attemptsFile, "utf8"))), 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI upscaler never changes an explicit tile size and removes partial failed output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-vram-explicit-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const output = join(directory, "partial.png");
  await writeFile(input, pngHeader(4, 3));
  await writeFile(binary, String.raw`#!/bin/sh
while [ "$1" != "" ]; do
  if [ "$1" = "-o" ]; then shift; printf 'partial' > "$1"; fi
  if [ "$1" = "-t" ]; then shift; if [ "$1" != "128" ]; then exit 9; fi; fi
  shift
done
echo "vkAllocateMemory failed" >&2
exit 2
`);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(
      adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, tile: 128, format: "png" }),
      error => error.code === "AI_UPSCALE_PROCESS_FAILED"
    );
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI upscaler does not retry non-memory process failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-no-retry-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const output = join(directory, "failed.png");
  const attemptsFile = join(directory, "attempts.txt");
  await writeFile(input, pngHeader(4, 3));
  await writeFile(binary, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const attemptsFile = ${JSON.stringify(attemptsFile)};
const count = fs.existsSync(attemptsFile) ? Number(fs.readFileSync(attemptsFile, "utf8")) : 0;
fs.writeFileSync(attemptsFile, String(count + 1));
process.stderr.write("unsupported image format");
process.exit(2);
`);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(
      adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, tile: 0, format: "png" }),
      error => error.code === "AI_UPSCALE_PROCESS_FAILED"
    );
    const { readFile, access } = await import("node:fs/promises");
    assert.equal(await readFile(attemptsFile, "utf8"), "1");
    await assert.rejects(access(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI upscaler rejects projected output dimensions before invoking the GPU process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-output-budget-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const output = join(directory, "must-not-exist.png");
  const attemptsFile = join(directory, "attempts.txt");
  await writeFile(input, pngHeader(16, 16));
  await writeFile(binary, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(attemptsFile)}, "invoked");
`);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, maxOutputPixels: 1000, enabled: true });
    await assert.rejects(
      adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, tile: 0, format: "png" }),
      error => error.code === "AI_UPSCALE_OUTPUT_BUDGET_EXCEEDED"
    );
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(attemptsFile));
    await assert.rejects(access(output));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI upscaler rejects output pixel budgets outside the safe worker ceiling", () => {
  assert.throws(() => createRealEsrganAdapter({ maxOutputPixels: 100_000_001 }), /pixel budget is invalid/);
});


function pngHeaderWithColorType(width, height, colorType = 6) {
  const bytes = Buffer.alloc(26);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes,0);
  bytes.writeUInt32BE(13,8);
  bytes.write("IHDR",12,"ascii");
  bytes.writeUInt32BE(width,16);
  bytes.writeUInt32BE(height,20);
  bytes[25] = colorType;
  return bytes;
}

test("AI upscaler rejects JPEG output for transparent sources before invoking the engine", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-alpha-jpeg-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "transparent.png");
  const output = join(directory, "must-not-run.jpg");
  const attemptsFile = join(directory, "attempts.txt");
  await writeFile(input, pngHeaderWithColorType(8, 6, 6));
  await writeFile(binary, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(attemptsFile)}, "invoked");
`);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(
      adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, format: "jpg" }),
      error => error.code === "AI_UPSCALE_ALPHA_JPEG_UNSUPPORTED"
    );
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(attemptsFile));
    await assert.rejects(access(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AI upscaler rejects and removes an output that loses source alpha transparency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-alpha-loss-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "transparent.png");
  const output = join(directory, "opaque.png");
  await writeFile(input, pngHeaderWithColorType(8, 6, 6));
  await writeFakeEngine(binary, null, 2, [8, 6]);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(
      adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, format: "png" }),
      error => error.code === "AI_UPSCALE_ALPHA_LOST"
    );
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AI upscaler reports transparency preservation when alpha-bearing output is retained", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-alpha-preserved-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "transparent.png");
  const output = join(directory, "transparent-enhanced.png");
  await writeFile(input, pngHeaderWithColorType(8, 6, 6));
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const out = args[args.indexOf("-o") + 1];
const scale = Number(args[args.indexOf("-s") + 1] || 2);
${pngBytes.toString()}
fs.writeFileSync(out,pngBytes(8*scale,6*scale,6));
`;
  await writeFile(binary, script);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    const result = await adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, format: "png" });
    assert.equal(result.sourceHasAlpha, true);
    assert.equal(result.outputHasAlpha, true);
    assert.equal(result.alphaPreserved, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function pngHeaderWithBitDepth(width, height, bitDepth, colorType = 2) {
  const bytes = Buffer.alloc(26);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes,0);
  bytes.writeUInt32BE(13,8);
  bytes.write("IHDR",12,"ascii");
  bytes.writeUInt32BE(width,16);
  bytes.writeUInt32BE(height,20);
  bytes[24] = bitDepth;
  bytes[25] = colorType;
  return bytes;
}

test("AI upscaler rejects 16-bit PNG before launching an uncertified 8-bit NCNN path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-16bit-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source-16bit.png");
  const output = join(directory, "must-not-run.png");
  const attemptsFile = join(directory, "attempts.txt");
  await writeFile(input, pngHeaderWithBitDepth(8, 6, 16));
  await writeFile(binary, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(attemptsFile)}, "invoked");
`);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(
      adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, format: "png" }),
      error => error.code === "AI_UPSCALE_BIT_DEPTH_UNSUPPORTED"
    );
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(attemptsFile));
    await assert.rejects(access(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AI upscaler accepts 8-bit PNG input and reports source and output sample depth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-8bit-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source-8bit.png");
  const output = join(directory, "enhanced-8bit.png");
  await writeFile(input, pngHeaderWithBitDepth(8, 6, 8));
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const out = args[args.indexOf("-o") + 1];
const scale = Number(args[args.indexOf("-s") + 1] || 2);
${pngBytes.toString()}
fs.writeFileSync(out,pngBytes(8*scale,6*scale,2));
`;
  await writeFile(binary, script);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    const result = await adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, format: "png" });
    assert.equal(result.sourceBitDepth, 8);
    assert.equal(result.outputBitDepth, 8);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("AI upscaler rejects 12-bit JPEG based on SOF precision before GPU execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-12bit-jpeg-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source-12bit.jpg");
  const output = join(directory, "must-not-run.png");
  const attemptsFile = join(directory, "attempts.txt");
  const jpeg = Buffer.from([
    0xff,0xd8, 0xff,0xc0, 0x00,0x0b, 0x0c, 0x00,0x06, 0x00,0x08, 0x01, 0x01,0x11,0x00
  ]);
  await writeFile(input, jpeg);
  await writeFile(binary, `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(attemptsFile)}, "invoked");
`);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(
      adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, format: "png" }),
      error => error.code === "AI_UPSCALE_BIT_DEPTH_UNSUPPORTED"
    );
    const { access } = await import("node:fs/promises");
    await assert.rejects(access(attemptsFile));
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("AI upscaler rejects a CRC-valid PNG with invalid DEFLATE data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-deflate-invalid-"));
  const binary = join(directory, "engine"), model = "realesrgan-x4plus";
  const input = join(directory, "source.png"), output = join(directory, "bad-deflate.png");
  await writeFile(input, pngHeader(1, 1));
  await writeFakeEngine(binary, null, 6, [1, 1], 0, { compressedData: Buffer.from([1,2,3,4,5,6]) });
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(adapter.execute({ inputPath: input, outputPath: output, model, scale: 2 }), error => error.code === "AI_UPSCALE_OUTPUT_INVALID");
    await assert.rejects(() => import("node:fs/promises").then(fs => fs.access(output)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AI upscaler accepts a valid PNG zlib stream split across consecutive IDAT chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-idat-split-"));
  const binary = join(directory, "engine"), model = "realesrgan-x4plus";
  const input = join(directory, "source.png"), output = join(directory, "split-idat.png");
  await writeFile(input, pngHeader(1, 1));
  await writeFakeEngine(binary, null, 6, [1, 1], 0, { splitIdat: true });
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    const result = await adapter.execute({ inputPath: input, outputPath: output, model, scale: 2 });
    assert.deepEqual(result.outputDimensions, { width: 2, height: 2 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AI upscaler accepts valid Adam7 interlaced PNG output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-adam7-"));
  const binary = join(directory, "engine"), model = "realesrgan-x4plus";
  const input = join(directory, "source.png"), output = join(directory, "adam7.png");
  await writeFile(input, pngHeader(1, 1));
  await writeFakeEngine(binary, null, 6, [1, 1], 0, { interlace: 1 });
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    const result = await adapter.execute({ inputPath: input, outputPath: output, model, scale: 2 });
    assert.deepEqual(result.outputDimensions, { width: 2, height: 2 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("AI upscaler rejects a checksum-invalid PNG output even when its dimensions look correct", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-bad-png-"));
  const binary = join(directory, "engine"), model = "realesrgan-x4plus";
  const input = join(directory, "source.png"), output = join(directory, "corrupt.png");
  await writeFile(input, pngHeader(1, 1));
  const generator = `#!/usr/bin/env node
const fs = require("node:fs"), zlib = require("node:zlib");
const out = process.argv[process.argv.indexOf("-o") + 1];
function chunk(type,data){const name=Buffer.from(type),body=Buffer.concat([name,data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const tail=Buffer.alloc(4);tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([len,body,tail]);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(2,0);ihdr.writeUInt32BE(2,4);ihdr[8]=8;ihdr[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(Buffer.alloc(18))),chunk("IEND",Buffer.alloc(0))]);png[png.length-5]^=0xff;fs.writeFileSync(out,png);
`;
  await writeFile(binary, generator); await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model"); await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, format: "png" }), error => error.code === "AI_UPSCALE_OUTPUT_INVALID");
    const { access } = await import("node:fs/promises"); await assert.rejects(access(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("AI upscaler rejects symlinked PNG output instead of validating a target file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-symlink-png-"));
  const binary = join(directory, "engine"), model = "realesrgan-x4plus";
  const input = join(directory, "source.png"), output = join(directory, "linked.png");
  await writeFile(input, pngHeader(1, 1));
  const generator = `#!/usr/bin/env node
const fs = require("node:fs"), args = process.argv.slice(2);
const out = args[args.indexOf("-o") + 1];
fs.symlinkSync(${JSON.stringify(input)}, out);
`;
  await writeFile(binary, generator); await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model"); await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, format: "png" }), error => error.code === "AI_UPSCALE_OUTPUT_INVALID");
    const { lstat, access } = await import("node:fs/promises");
    await assert.rejects(lstat(output));
    await access(input);
  } finally { await rm(directory, { recursive: true, force: true }); }
});



for (const format of ["jpg", "webp"]) {
  test(`AI upscaler rejects symlinked ${format.toUpperCase()} output paths`, async () => {
    const directory = await mkdtemp(join(tmpdir(), `ev-ai-upscale-symlink-${format}-`));
    const binary = join(directory, "engine"), model = "realesrgan-x4plus";
    const input = join(directory, "source.png"), output = join(directory, `linked.${format}`);
    await writeFile(input, pngHeader(1, 1));
    const generator = `#!/usr/bin/env node
const fs = require("node:fs"), args = process.argv.slice(2), out = args[args.indexOf("-o") + 1];
fs.symlinkSync(${JSON.stringify(input)}, out);
`;
    await writeFile(binary, generator); await chmod(binary, 0o755);
    await writeFile(join(directory, model + ".param"), "model"); await writeFile(join(directory, model + ".bin"), "weights");
    try {
      const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
      await assert.rejects(adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, format }), error => error.code === "AI_UPSCALE_OUTPUT_INVALID");
      const { lstat, access } = await import("node:fs/promises");
      await assert.rejects(lstat(output));
      await access(input);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test("AI upscaler rejects PNG containers with empty image-data chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-empty-idat-"));
  const binary = join(directory, "engine"), model = "realesrgan-x4plus";
  const input = join(directory, "source.png"), output = join(directory, "empty-idat.png");
  await writeFile(input, pngHeader(1, 1));
  const generator = `#!/usr/bin/env node
const fs = require("node:fs"), args = process.argv.slice(2), out = args[args.indexOf("-o") + 1];
function chunk(type,data){const name=Buffer.from(type),body=Buffer.concat([name,data]);let crc=0xffffffff;for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const tail=Buffer.alloc(4);tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([len,body,tail]);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(2,0);ihdr.writeUInt32BE(2,4);ihdr[8]=8;ihdr[9]=6;
fs.writeFileSync(out,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",Buffer.alloc(0)),chunk("IEND",Buffer.alloc(0))]));
`;
  await writeFile(binary, generator); await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model"); await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(adapter.execute({ inputPath: input, outputPath: output, model, scale: 2, format: "png" }), error => error.code === "AI_UPSCALE_OUTPUT_INVALID");
    const { access } = await import("node:fs/promises"); await assert.rejects(access(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
