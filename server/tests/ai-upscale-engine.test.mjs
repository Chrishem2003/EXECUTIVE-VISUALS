import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRealEsrganAdapter } from "../ai-upscale-engine.mjs";

function pngHeader(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes,0);
  bytes.writeUInt32BE(13,8);
  bytes.write("IHDR",12,"ascii");
  bytes.writeUInt32BE(width,16);
  bytes.writeUInt32BE(height,20);
  return bytes;
}

async function writeFakeEngine(path, fixedDimension = null) {
  const sizeExpression = fixedDimension === null ? "requestedScale" : String(fixedDimension);
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const out = args[args.indexOf("-o") + 1];
const requestedScale = Number(args[args.indexOf("-s") + 1] || 2);
const size = ${sizeExpression};
const png = Buffer.alloc(24);
Buffer.from([137,80,78,71,13,10,26,10]).copy(png,0);
png.writeUInt32BE(13,8);
png.write("IHDR",12,"ascii");
png.writeUInt32BE(size,16);
png.writeUInt32BE(size,20);
fs.writeFileSync(out,png);
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
const attemptsFile = ${JSON.stringify(attemptsFile)};
const previous = fs.existsSync(attemptsFile) ? Number(fs.readFileSync(attemptsFile, "utf8")) : 0;
fs.writeFileSync(attemptsFile, String(previous + 1));
if (tile === 0 || tile === 256) {
  fs.writeFileSync(output, "partial-output");
  process.stderr.write("vkAllocateMemory failed: VK_ERROR_OUT_OF_DEVICE_MEMORY");
  process.exit(2);
}
const png = Buffer.alloc(24);
Buffer.from([137,80,78,71,13,10,26,10]).copy(png, 0);
png.writeUInt32BE(13, 8);
png.write("IHDR", 12, "ascii");
png.writeUInt32BE(input.readUInt32BE(16) * scale, 16);
png.writeUInt32BE(input.readUInt32BE(20) * scale, 20);
fs.writeFileSync(output, png);
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
  await writeFakeEngine(binary);
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
const png = Buffer.alloc(26);
Buffer.from([137,80,78,71,13,10,26,10]).copy(png,0);
png.writeUInt32BE(13,8); png.write("IHDR",12,"ascii");
png.writeUInt32BE(8*scale,16); png.writeUInt32BE(6*scale,20); png[25]=6;
fs.writeFileSync(out,png);
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
