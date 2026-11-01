import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRealEsrganAdapter } from "../ai-upscale-engine.mjs";

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
  await writeFile(input, Buffer.from([137,80,78,71,13,10,26,10]));
  await writeFile(binary, '#!/bin/sh\nwhile [ "$1" != "" ]; do if [ "$1" = "-o" ]; then shift; printf "PNGDATA!!" > "$1"; fi; shift; done\n');
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000 });
    const result = await adapter.execute({ inputPath: input, outputPath: output, model, scale: 4, tile: 128, format: "png" });
    assert.equal(result.method, "ai-super-resolution");
    assert.equal(result.byteSize, 9);
    assert.equal(result.model, model);
    await assert.rejects(adapter.execute({ inputPath: input, outputPath: output, model }), error => error.code === "AI_UPSCALE_OUTPUT_EXISTS");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
