import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link as createLink, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRealEsrganAdapter } from "../ai-upscale-engine.mjs";

test("AI upscaler atomically publishes one final inode and removes its private sibling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-ai-upscale-publication-"));
  const binary = join(directory, "engine");
  const model = "realesrgan-x4plus";
  const input = join(directory, "source.png");
  const output = join(directory, "published.png");
  await writeFile(input, Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1]));
  await writeFile(binary, String.raw`#!/bin/sh
while [ "$1" != "" ]; do
  if [ "$1" = "-o" ]; then shift; printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\004\000\000\000\004' > "$1"; fi
  shift
done
`);
  await chmod(binary, 0o755);
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  try {
    const adapter = createRealEsrganAdapter({ binaryPath: binary, modelDirectory: directory, timeoutMs: 5000, enabled: true });
    const result = await adapter.execute({ inputPath: input, outputPath: output, model, scale: 4, format: "png" });
    assert.equal(result.method, "ai-super-resolution");
    assert.equal((await stat(output)).nlink, 1, "temporary hard-link name must be removed after publication");
    assert.equal((await stat(output)).size, result.byteSize, "published output size must match validated inference output");
    assert.deepEqual(await readFile(output), Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,4,0,0,0,4]), "published bytes must be identical to the validated inference output");
    assert.deepEqual((await readdir(directory)).filter(name => name.startsWith(".ev-upscale-")), []);
    await assert.rejects(createLink(output, join(directory, "unexpected-link.png")), /EEXIST/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
