import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudMediaExecutor } from "../cloud-media-executor.mjs";

async function executable(directory,name,body){
  const path=join(directory,name);
  await writeFile(path,"#!/bin/sh\nif [ \"$1\" = \"-version\" ]; then exit 0; fi\n"+body+"\n","utf8");
  await chmod(path,0o755);
  return path;
}

test("cloud media executor blocks publication when a derivative lacks its expected stream", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-cloud-output-validation-test-"));
  const previousFfmpeg = process.env.FFMPEG_PATH;
  const previousFfprobe = process.env.FFPROBE_PATH;
  const source = join(directory, "source.mp4");
  await writeFile(source, "source");
  process.env.FFMPEG_PATH = await executable(directory, "ffmpeg", 'for last do :; done\nprintf "output" > "$last"');
  process.env.FFPROBE_PATH = await executable(directory, "ffprobe", "printf '%s\\n' '{\"streams\":[{\"codec_type\":\"audio\"}],\"format\":{\"duration\":\"1.0\"}}'");
  let publishCount = 0;
  try {
    const execute = createCloudMediaExecutor({
      tempRoot: directory,
      mediaIO: {
        async materialize() { return { path: source, asset: { id: "source-invalid", name: "scene.mp4", mediaType: "video/mp4", sha256: "c".repeat(64) }, async cleanup() {} }; },
        async publish() { publishCount++; }
      }
    });
    await assert.rejects(execute({ job: { id: "job-invalid-stream", owner_id: "owner", job_type: "media.color", input: { sourceAssetId: "source-invalid" } }, onProgress() {} }), error => error.code === "MEDIA_OUTPUT_VALIDATION_FAILED");
    assert.equal(publishCount, 0, "invalid cloud derivative must not be published");
  } finally {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    if (previousFfprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousFfprobe;
    await rm(directory, { recursive: true, force: true });
  }
});
