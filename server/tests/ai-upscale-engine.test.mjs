import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRealEsrganAdapter } from "../ai-upscale-engine.mjs";
import { validateAiUpscaleProbeDimensions, buildAiUpscaleProvenance } from "../media.mjs";

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

test("AI upscaler launches without a shell and publishes only a new bounded output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const output = join(directory, "enhanced.png");
  await writeFile(input, Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]));
  await writeFile(binary, String.raw`#!/bin/sh
while [ "$1" != "" ]; do if [ "$1" = "-o" ]; then shift; printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\004\000\000\000\004' > "$1"; fi; shift; done
`);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    const result = await adapter.execute({ inputPath: input, outputPath: output, model, scale: 4, tile: 128, format: "png" });
    assert.equal(result.method, "ai-super-resolution");
    assert.ok(result.byteSize >= 24);
    assert.equal(result.model, model);
    assert.match(result.modelVersion,/^[a-f0-9]{64}:[a-f0-9]{64}$/);
    assert.ok(Number.isInteger(result.durationMs)&&result.durationMs>=1);
    await assert.rejects(adapter.execute({ inputPath: input, outputPath: output, model }), error => error.code === "AI_UPSCALE_OUTPUT_EXISTS");
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("AI upscaler reports execution checks separately from unverified inference quality", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-selftest-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "fixture.png");
  await writeFile(input, Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]));
  await writeFile(binary, String.raw`#!/bin/sh
while [ "$1" != "" ]; do if [ "$1" = "-o" ]; then shift; printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\004\000\000\000\004' > "$1"; fi; shift; done
`);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    const before = await adapter.probe(model);
    assert.equal(before.executionVerified, false);
    assert.equal(before.inferenceVerified, false);
    const result = await adapter.selfTest({ inputPath: input, model, scale: 4 });
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
  await writeFile(input, Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]));
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

test("AI upscaler does not overwrite a symbolic-link output target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-link-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const protectedFile = join(directory, "protected.png");
  const output = join(directory, "linked-output.png");
  await writeFile(input, Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]));
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


test("AI upscaler does not overwrite a target created while inference is running", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-race-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const protectedFile = join(directory, "protected.png");
  const output = join(directory, "late-linked-output.png");
  await writeFile(input, Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]));
  await writeFile(protectedFile, "preserve-this-file");
  await writeFile(binary, String.raw`#!/bin/sh
while [ "$1" != "" ]; do
  if [ "$1" = "-o" ]; then
    shift
    ln -s '${protectedFile}' '${output}'
    printf '%b' '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\004\000\000\000\004' > "$1"
  fi
  shift
done
`);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(
      adapter.execute({ inputPath: input, outputPath: output, model, scale: 4, format: "png" }),
      error => error.code === "AI_UPSCALE_OUTPUT_EXISTS"
    );
    const { readFile, lstat } = await import("node:fs/promises");
    assert.equal(await readFile(protectedFile, "utf8"), "preserve-this-file");
    assert.equal((await lstat(output)).isSymbolicLink(), true);
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith(".ev-upscale-")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("AI upscaler fingerprints executable and model contents, not file size or timestamps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-fingerprint-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "fixture.png");
  const weights = join(directory, model + ".bin");
  await writeFile(input, Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]));
  await writeFile(binary, String.raw`#!/bin/sh
while [ "$1" != "" ]; do if [ "$1" = "-o" ]; then shift; printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\004\000\000\000\004' > "$1"; fi; shift; done
`);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(weights, "weights-v1");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    const passed = await adapter.selfTest({ inputPath: input, model, scale: 4 });
    assert.match(passed.binarySha256, /^[a-f0-9]{64}$/);
    assert.match(passed.modelFilesSha256, /^[a-f0-9]{64}$/);
    assert.equal((await adapter.probe(model)).executionVerified, true);
    await writeFile(weights, "weights-v2");
    const changed = await adapter.probe(model);
    assert.equal(changed.executionVerified, false, "changed weights must invalidate the worker self-test");
    assert.notEqual(changed.modelFilesSha256, passed.modelFilesSha256);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("local AI upscale FFprobe validation requires exact positive integer dimensions", () => {
  assert.deepEqual(validateAiUpscaleProbeDimensions(JSON.stringify({streams:[{width:768,height:512}]}),{width:768,height:512}),{width:768,height:512});
  for (const output of [
    "{",
    JSON.stringify({streams:[]}),
    JSON.stringify({streams:[{width:0,height:512}]}),
    JSON.stringify({streams:[{width:768,height:512.5}]}),
    JSON.stringify({streams:[{width:767,height:512}]})
  ]) assert.throws(()=>validateAiUpscaleProbeDimensions(output,{width:768,height:512}),error=>error.code==="MEDIA_OUTPUT_VALIDATION_FAILED");
});


test("AI upscale provenance binds the exact source, output and pinned model build", () => {
  const digest = char => char.repeat(64);
  const result = {
    engine:"realesrgan-ncnn-vulkan",method:"ai-super-resolution",model:"realesrgan-x4plus",
    modelVersion:digest("a")+":"+digest("b"),scale:4,tile:128,sourceWidth:320,sourceHeight:240,
    binarySha256:digest("a"),modelFilesSha256:digest("b"),durationMs:1450
  };
  const provenance = buildAiUpscaleProvenance({
    result,sourceAsset:{id:"source-asset",sha256:digest("c")},outputSha256:digest("d"),
    durationMs:result.durationMs,dimensions:{width:1280,height:960}
  });
  assert.equal(provenance.sourceAssetId,"source-asset");
  assert.equal(provenance.inputSha256,digest("c"));
  assert.equal(provenance.outputSha256,digest("d"));
  assert.equal(provenance.modelVersion,result.modelVersion);
  assert.equal(provenance.durationMs,1450);
  assert.equal(provenance.qualityReview,"not_reviewed");
  assert.equal(provenance.dimensionsVerified,true);
  assert.throws(()=>buildAiUpscaleProvenance({
    result,sourceAsset:{id:"source-asset",sha256:"missing"},outputSha256:digest("d"),
    durationMs:1450,dimensions:{width:1280,height:960}
  }),error=>error.code==="MEDIA_PROVENANCE_INVALID");
});


test("AI upscaler refuses publication when pinned model weights change during inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-engine-race-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const output = join(directory, "enhanced.png");
  const weights = join(directory, model + ".bin");
  await writeFile(input, Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]));
  await writeFile(weights, "weights-v1");
  await writeFile(binary, `#!/bin/sh
printf 'weights-v2' > '${weights}'
while [ "$1" != "" ]; do
  if [ "$1" = "-o" ]; then shift; printf '\\211PNG\\r\\n\\032\\n\\000\\000\\000\\015IHDR\\000\\000\\000\\004\\000\\000\\000\\004' > "$1"; fi
  shift
done
`);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    await assert.rejects(
      adapter.execute({ inputPath: input, outputPath: output, model, scale: 4, format: "png" }),
      error => error.code === "AI_UPSCALE_ENGINE_CHANGED"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("AI upscale cancellation waits for the native process to exit before removing its temporary output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-cancel-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const output = join(directory, "result.png");
  const pidFile = join(directory, "engine.pid");
  const controller = new AbortController();
  const script = [
    "#!/usr/bin/env node",
    'require("node:fs").writeFileSync(' + JSON.stringify(pidFile) + ', String(process.pid));',
    'process.on("SIGTERM", () => {});',
    'setInterval(() => {}, 1000);'
  ].join("\n") + "\n";
  await writeFile(input, Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]));
  await writeFile(binary, script);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 10000, enabled: true });
    const pending = adapter.execute({ inputPath: input, outputPath: output, model, scale: 4, signal: controller.signal });
    let pidText = "";
    for (let attempt = 0; attempt < 100 && !pidText; attempt++) {
      try { pidText = await readFile(pidFile, "utf8"); } catch {}
      if (!pidText) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.match(pidText, /^\\d+$/, "native engine should start before cancellation");
    const pid = Number(pidText);
    controller.abort();
    await assert.rejects(pending, error => error.code === "JOB_CANCELLED");
    assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH",
      "cancellation must wait until the native engine has exited");
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith(".ev-upscale-")), [],
      "the temporary output must be cleaned after the engine exits");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
