import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudMediaExecutor } from "../cloud-media-executor.mjs";

async function executable(directory, name, body) {
  const path = join(directory, name);
  await writeFile(path, "#!/bin/sh\n" + body + "\n", "utf8");
  await chmod(path, 0o755);
  return path;
}

test("cloud audio probe reports heuristic non-silence activity intervals without claiming speech recognition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-cloud-audio-probe-test-"));
  const previousProbe = process.env.FFPROBE_PATH, previousFfmpeg = process.env.FFMPEG_PATH;
  const source = join(directory, "source.wav");
  await writeFile(source, "fixture");
  const ffprobe = await executable(directory, "ffprobe", String.raw`printf '%s' '{"streams":[{"codec_type":"audio","codec_name":"pcm_s16le"}],"format":{"duration":"10"}}'`);
  const ffmpeg = await executable(directory, "ffmpeg", String.raw`if [ "$1" = "-version" ]; then echo "ffmpeg test"; exit 0; fi
printf '%s\n' '[silencedetect @ 0x1] silence_start:2.000' '[silencedetect @ 0x1] silence_end:4.000 | silence_duration:2.000' '[silencedetect @ 0x1] silence_start:6.000' '[silencedetect @ 0x1] silence_end:8.000 | silence_duration:2.000' >&2`);
  process.env.FFPROBE_PATH = ffprobe; process.env.FFMPEG_PATH = ffmpeg;
  try {
    const execute = createCloudMediaExecutor({
      tempRoot: directory,
      mediaIO: {
        async materialize() { return { path: source, asset: { id: "audio-1", name: "voice.wav", mediaType: "audio/wav", sha256: "a".repeat(64) }, async cleanup() {} }; },
        async publish() { throw new Error("Probe jobs must not publish derivatives."); }
      }
    });
    const result = await execute({ job: { id: "job-audio-probe", owner_id: "owner", project_id: "project", job_type: "media.probe", input: { sourceAssetId: "audio-1" } } });
    const analysis = result.metadata.signalAnalysis.audioActivity;
    assert.equal(analysis.status, "completed");
    assert.equal(analysis.activityMethod, "non-silence-envelope");
    assert.deepEqual(analysis.silence.map(item => [item.startSeconds, item.endSeconds]), [[2,4],[6,8]]);
    assert.deepEqual(analysis.activityIntervals.map(item => [item.startSeconds, item.endSeconds]), [[0,2.08],[3.92,6.08],[7.92,10]]);
    assert.ok(analysis.limitations.some(item => item.includes("not speech recognition")));
  } finally {
    if (previousProbe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousProbe;
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    await rm(directory, { recursive: true, force: true });
  }
});

test("cloud media probe uses the leased owner and cleans up its materialized source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-cloud-executor-test-"));
  const previous = process.env.FFPROBE_PATH;
  const source = join(directory, "source.mp4");
  await writeFile(source, "fixture");
  const ffprobe = await executable(directory, "ffprobe", String.raw`printf '%s' '{"streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","width":640,"height":360}],"format":{"duration":"1.25"}}'`);
  process.env.FFPROBE_PATH = ffprobe;
  let materializedArgs, cleaned = false;
  try {
    const execute = createCloudMediaExecutor({
      tempRoot: directory,
      mediaIO: {
        async materialize(args) {
          materializedArgs = args;
          return {
            path: source,
            asset: { id: "asset-1", name: "clip.mp4", mediaType: "video/mp4", sha256: "a".repeat(64) },
            async cleanup() { cleaned = true; }
          };
        },
        async publish() { throw new Error("Probe jobs must not publish derivatives."); }
      }
    });
    const result = await execute({
      job: { id: "job-1", owner_id: "verified-owner", project_id: "project-1", job_type: "media.probe", input: { sourceAssetId: "asset-1" } },
      onProgress() {}
    });
    assert.deepEqual(materializedArgs, { ownerId: "verified-owner", assetId: "asset-1" });
    assert.equal(result.metadata.format.duration, "1.25");
    assert.equal(result.sourceAssetId, "asset-1");
    assert.equal(cleaned, true);
  } finally {
    if (previous === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("cloud media enhancement publishes a checksummed derivative using the claimed job identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-cloud-executor-test-"));
  const previous = process.env.FFMPEG_PATH;
  const previousProbe = process.env.FFPROBE_PATH;
  const source = join(directory, "source.mp4");
  await writeFile(source, "source-media");
  const ffmpeg = await executable(directory, "ffmpeg", 'for last do :; done\nprintf "rendered-media" > "$last"');
  const ffprobe = await executable(directory, "ffprobe", String.raw`printf '%s' '{"streams":[{"codec_type":"video","width":640,"height":360}],"format":{"duration":"1.0"}}'`);
  process.env.FFMPEG_PATH = ffmpeg;
  process.env.FFPROBE_PATH = ffprobe;
  let published, publishedContent, cleaned = false;
  try {
    const execute = createCloudMediaExecutor({
      tempRoot: directory,
      mediaIO: {
        async materialize({ ownerId, assetId }) {
          assert.equal(ownerId, "verified-owner");
          assert.equal(assetId, "asset-source");
          return {
            path: source,
            asset: { id: "asset-source", name: "scene.mp4", mediaType: "video/mp4", sha256: "b".repeat(64) },
            async cleanup() { cleaned = true; }
          };
        },
        async publish(args) {
          published = args;
          publishedContent = await readFile(args.path, "utf8");
          return { id: "asset-output", name: args.filename, mediaType: args.mediaType };
        }
      }
    });
    const result = await execute({
      job: {
        id: "job-2", owner_id: "verified-owner", project_id: "project-2",
        job_type: "media.color",
        input: { sourceAssetId: "asset-source", brightness: 0.1, contrast: 1, saturation: 1 }
      },
      onProgress() {}
    });
    assert.equal(published.ownerId, "verified-owner");
    assert.equal(published.projectId, "project-2");
    assert.equal(published.derivativeOf, "asset-source");
    assert.equal(published.mediaType, "video/mp4");
    assert.equal(result.outputAsset.id, "asset-output");
    assert.equal(result.sha256.length, 64);
    assert.equal(result.byteSize, Buffer.byteLength("rendered-media"));
    assert.equal(cleaned, true);
    assert.equal(publishedContent, "rendered-media");
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previous;
    if (previousProbe === undefined) delete process.env.FFPROBE_PATH;
    else process.env.FFPROBE_PATH = previousProbe;
    await rm(directory, { recursive: true, force: true });
  }
});

test("cloud media executor rejects timeline jobs until timeline persistence is cloud-backed", async () => {
  let materialized = false;
  const execute = createCloudMediaExecutor({
    mediaIO: {
      async materialize() { materialized = true; throw new Error("Should not materialize."); },
      async publish() {}
    }
  });
  await assert.rejects(
    execute({ job: { id: "job-3", owner_id: "owner", job_type: "timeline.render", input_json: "{}" } }),
    error => error.code === "CLOUD_MEDIA_OPERATION_UNSUPPORTED"
  );
  assert.equal(materialized, false);
});

test("cloud media executor rejects source IDs missing from the leased job input", async () => {
  const execute = createCloudMediaExecutor({
    mediaIO: { async materialize() { throw new Error("Should not materialize."); }, async publish() {} }
  });
  await assert.rejects(
    execute({ job: { id: "job-4", owner_id: "owner", job_type: "media.probe", input_json: "{}" } }),
    error => error.code === "SOURCE_ASSET_NOT_FOUND"
  );
});

test("cloud upscale verifies requested dimensions before publishing and records its classical method", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-cloud-upscale-test-"));
  const previousFfmpeg = process.env.FFMPEG_PATH;
  const previousFfprobe = process.env.FFPROBE_PATH;
  const source = join(directory, "source.mp4");
  await writeFile(source, "source-media");
  const ffmpeg = await executable(directory, "ffmpeg", 'for last do :; done\nprintf "upscaled-media" > "$last"');
  const ffprobe = await executable(directory, "ffprobe", String.raw`for last do :; done
case "$last" in */source.mp4) printf '%s' '{"streams":[{"codec_type":"video"},{"codec_type":"audio"}],"format":{"duration":"1.25"}}';; *) printf '%s' '{"streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","width":642,"height":360},{"codec_type":"audio"}],"format":{"duration":"1.25"}}';; esac`);
  process.env.FFMPEG_PATH = ffmpeg;
  process.env.FFPROBE_PATH = ffprobe;
  let published;
  try {
    const execute = createCloudMediaExecutor({
      tempRoot: directory,
      mediaIO: {
        async materialize() {
          return { path: source, asset: { id: "asset-up", name: "scene.mp4", mediaType: "video/mp4", sha256: "c".repeat(64) }, async cleanup() {} };
        },
        async publish(args) { published = args; return { id: "asset-upscaled", name: args.filename }; }
      }
    });
    const result = await execute({
      job: { id: "job-up", owner_id: "owner-up", job_type: "media.upscale", input: { sourceAssetId: "asset-up", width: 641, height: 359, algorithm: "spline36", sharpness: 0.5 } },
      onProgress() {}
    });
    assert.equal(result.processing.method, "classical-resampling");
    assert.equal(result.processing.algorithm, "spline36");
    assert.equal(result.processing.targetWidth, 642);
    assert.equal(result.processing.targetHeight, 360);
    assert.equal(result.processing.sourceDurationSeconds, 1.25);
    assert.equal(result.processing.outputDurationSeconds, 1.25);
    assert.equal(result.processing.durationDeltaSeconds, 0);
    assert.equal(result.processing.sourceAudioStreamCount, 1);
    assert.equal(result.processing.outputAudioStreamCount, 1);
    assert.equal(result.processing.audioPreserved, true);
    assert.equal(result.processing.outputVideo.codec_name, "h264");
    assert.equal(result.processing.outputVideo.pix_fmt, "yuv420p");
    assert.equal(result.processing.outputVideo.width, 642);
    assert.equal(result.processing.outputVideo.height, 360);
    assert.equal(published.metadata.processing.sharpness, 0.5);
  } finally {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    if (previousFfprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousFfprobe;
    await rm(directory, { recursive: true, force: true });
  }
});

test("cloud upscale refuses to publish when FFprobe dimensions differ from the request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-cloud-upscale-reject-test-"));
  const previousFfmpeg = process.env.FFMPEG_PATH;
  const previousFfprobe = process.env.FFPROBE_PATH;
  const source = join(directory, "source.mp4");
  await writeFile(source, "source-media");
  process.env.FFMPEG_PATH = await executable(directory, "ffmpeg", 'for last do :; done\nprintf "bad-size" > "$last"');
  process.env.FFPROBE_PATH = await executable(directory, "ffprobe", String.raw`for last do :; done
case "$last" in */source.mp4) printf '%s' '{"streams":[{"codec_type":"video"},{"codec_type":"audio"}],"format":{"duration":"1.25"}}';; *) printf '%s' '{"streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","width":320,"height":180},{"codec_type":"audio"}],"format":{"duration":"1.25"}}';; esac`);
  let publishCount = 0;
  try {
    const execute = createCloudMediaExecutor({
      tempRoot: directory,
      mediaIO: {
        async materialize() { return { path: source, asset: { id: "asset-reject", name: "scene.mp4", mediaType: "video/mp4", sha256: "d".repeat(64) }, async cleanup() {} }; },
        async publish() { publishCount++; }
      }
    });
    await assert.rejects(
      execute({ job: { id: "job-reject", owner_id: "owner", job_type: "media.upscale", input: { sourceAssetId: "asset-reject", width: 640, height: 360 } }, onProgress() {} }),
      error => error.code === "MEDIA_OUTPUT_VALIDATION_FAILED"
    );
    assert.equal(publishCount, 0, "invalid derivative must never be published");
  } finally {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    if (previousFfprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousFfprobe;
    await rm(directory, { recursive: true, force: true });
  }
});


test("cloud upscale refuses to publish when FFprobe uses an incompatible output codec", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-cloud-upscale-codec-test-"));
  const previousFfmpeg = process.env.FFMPEG_PATH;
  const previousFfprobe = process.env.FFPROBE_PATH;
  const source = join(directory, "source.mp4");
  await writeFile(source, "source-media");
  process.env.FFMPEG_PATH = await executable(directory, "ffmpeg", 'for last do :; done\nprintf "bad-codec" > "$last"');
  process.env.FFPROBE_PATH = await executable(directory, "ffprobe", String.raw`for last do :; done
case "$last" in */source.mp4) printf '%s' '{"streams":[{"codec_type":"video"},{"codec_type":"audio"}],"format":{"duration":"1.25"}}';; *) printf '%s' '{"streams":[{"codec_type":"video","codec_name":"mpeg4","pix_fmt":"yuv420p","width":640,"height":360},{"codec_type":"audio"}],"format":{"duration":"1.25"}}';; esac`);
  let publishCount = 0;
  try {
    const execute = createCloudMediaExecutor({
      tempRoot: directory,
      mediaIO: {
        async materialize() { return { path: source, asset: { id: "asset-codec", name: "scene.mp4", mediaType: "video/mp4", sha256: "b".repeat(64) }, async cleanup() {} }; },
        async publish() { publishCount++; }
      }
    });
    await assert.rejects(
      execute({ job: { id: "job-codec", owner_id: "owner", job_type: "media.upscale", input: { sourceAssetId: "asset-codec", width: 640, height: 360 } }, onProgress() {} }),
      error => error.code === "MEDIA_OUTPUT_VALIDATION_FAILED"
    );
    assert.equal(publishCount, 0, "codec-incompatible derivative must never be published");
  } finally {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    if (previousFfprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousFfprobe;
    await rm(directory, { recursive: true, force: true });
  }
});


test("cloud upscale refuses to publish when the source audio stream is lost", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-cloud-upscale-audio-test-"));
  const previousFfmpeg = process.env.FFMPEG_PATH;
  const previousFfprobe = process.env.FFPROBE_PATH;
  const source = join(directory, "source.mp4");
  await writeFile(source, "source-media");
  process.env.FFMPEG_PATH = await executable(directory, "ffmpeg", 'for last do :; done\nprintf "upscaled-media" > "$last"');
  process.env.FFPROBE_PATH = await executable(directory, "ffprobe", String.raw`for last do :; done
case "$last" in */source.mp4) printf '%s' '{"streams":[{"codec_type":"video"},{"codec_type":"audio"}],"format":{"duration":"1.25"}}';; *) printf '%s' '{"streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","width":640,"height":360}],"format":{"duration":"1.25"}}';; esac`);
  let publishCount = 0;
  try {
    const execute = createCloudMediaExecutor({
      tempRoot: directory,
      mediaIO: {
        async materialize() { return { path: source, asset: { id: "asset-audio", name: "scene.mp4", mediaType: "video/mp4", sha256: "e".repeat(64) }, async cleanup() {} }; },
        async publish() { publishCount++; }
      }
    });
    await assert.rejects(
      execute({ job: { id: "job-audio", owner_id: "owner", job_type: "media.upscale", input: { sourceAssetId: "asset-audio", width: 640, height: 360 } }, onProgress() {} }),
      error => error.code === "MEDIA_OUTPUT_VALIDATION_FAILED"
    );
    assert.equal(publishCount, 0, "audio-deficient derivative must never be published");
  } finally {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    if (previousFfprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousFfprobe;
    await rm(directory, { recursive: true, force: true });
  }
});


test("cloud upscale refuses to publish when the output duration drifts from source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-cloud-upscale-duration-test-"));
  const previousFfmpeg = process.env.FFMPEG_PATH;
  const previousFfprobe = process.env.FFPROBE_PATH;
  const source = join(directory, "source.mp4");
  await writeFile(source, "source-media-duration");
  process.env.FFMPEG_PATH = await executable(directory, "ffmpeg", 'for last do :; done\nprintf "upscaled-media" > "$last"');
  process.env.FFPROBE_PATH = await executable(directory, "ffprobe", String.raw`for last do :; done
case "$last" in */source.mp4) printf '%s' '{"streams":[{"codec_type":"video"},{"codec_type":"audio"}],"format":{"duration":"1.25"}}';; *) printf '%s' '{"streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","width":640,"height":360},{"codec_type":"audio"}],"format":{"duration":"2.5"}}';; esac`);
  let publishCount = 0;
  try {
    const execute = createCloudMediaExecutor({
      tempRoot: directory,
      mediaIO: {
        async materialize() { return { path: source, asset: { id: "asset-duration", name: "scene.mp4", mediaType: "video/mp4", sha256: "f".repeat(64) }, async cleanup() {} }; },
        async publish() { publishCount++; }
      }
    });
    await assert.rejects(
      execute({ job: { id: "job-duration", owner_id: "owner", job_type: "media.upscale", input: { sourceAssetId: "asset-duration", width: 640, height: 360 } }, onProgress() {} }),
      error => error.code === "MEDIA_OUTPUT_VALIDATION_FAILED"
    );
    assert.equal(publishCount, 0, "duration-drift derivative must never be published");
  } finally {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    if (previousFfprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousFfprobe;
    await rm(directory, { recursive: true, force: true });
  }
});


test("cloud upscale refuses to publish an unsupported video codec", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-cloud-upscale-codec-test-"));
  const previousFfmpeg = process.env.FFMPEG_PATH;
  const previousFfprobe = process.env.FFPROBE_PATH;
  const source = join(directory, "source.mp4");
  await writeFile(source, "source-media-codec");
  process.env.FFMPEG_PATH = await executable(directory, "ffmpeg", 'for last do :; done\nprintf "upscaled-media" > "$last"');
  process.env.FFPROBE_PATH = await executable(directory, "ffprobe", String.raw`for last do :; done
case "$last" in */source.mp4) printf '%s' '{"streams":[{"codec_type":"video"},{"codec_type":"audio"}],"format":{"duration":"1.25"}}';; *) printf '%s' '{"streams":[{"codec_type":"video","codec_name":"mpeg4","pix_fmt":"yuv420p","width":640,"height":360},{"codec_type":"audio"}],"format":{"duration":"2.5"}}';; esac`);
  let publishCount = 0;
  try {
    const execute = createCloudMediaExecutor({
      tempRoot: directory,
      mediaIO: {
        async materialize() { return { path: source, asset: { id: "asset-codec", name: "scene.mp4", mediaType: "video/mp4", sha256: "a".repeat(64) }, async cleanup() {} }; },
        async publish() { publishCount++; }
      }
    });
    await assert.rejects(
      execute({ job: { id: "job-codec", owner_id: "owner", job_type: "media.upscale", input: { sourceAssetId: "asset-codec", width: 640, height: 360 } }, onProgress() {} }),
      error => error.code === "MEDIA_OUTPUT_VALIDATION_FAILED"
    );
    assert.equal(publishCount, 0, "unsupported-codec derivative must never be published");
  } finally {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    if (previousFfprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousFfprobe;
    await rm(directory, { recursive: true, force: true });
  }
});


test("cloud upscale refuses to publish an incompatible pixel format", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-cloud-upscale-pixfmt-test-"));
  const previousFfmpeg = process.env.FFMPEG_PATH;
  const previousFfprobe = process.env.FFPROBE_PATH;
  const source = join(directory, "source.mp4");
  await writeFile(source, "source-media-pixfmt");
  process.env.FFMPEG_PATH = await executable(directory, "ffmpeg", 'for last do :; done\nprintf "upscaled-media" > "$last"');
  process.env.FFPROBE_PATH = await executable(directory, "ffprobe", String.raw`for last do :; done
case "$last" in */source.mp4) printf '%s' '{"streams":[{"codec_type":"video"},{"codec_type":"audio"}],"format":{"duration":"1.25"}}';; *) printf '%s' '{"streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuv444p","width":640,"height":360},{"codec_type":"audio"}],"format":{"duration":"2.5"}}';; esac`);
  let publishCount = 0;
  try {
    const execute = createCloudMediaExecutor({
      tempRoot: directory,
      mediaIO: {
        async materialize() { return { path: source, asset: { id: "asset-pixfmt", name: "scene.mp4", mediaType: "video/mp4", sha256: "b".repeat(64) }, async cleanup() {} }; },
        async publish() { publishCount++; }
      }
    });
    await assert.rejects(
      execute({ job: { id: "job-pixfmt", owner_id: "owner", job_type: "media.upscale", input: { sourceAssetId: "asset-pixfmt", width: 640, height: 360 } }, onProgress() {} }),
      error => error.code === "MEDIA_OUTPUT_VALIDATION_FAILED"
    );
    assert.equal(publishCount, 0, "incompatible-pixel-format derivative must never be published");
  } finally {
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    if (previousFfprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousFfprobe;
    await rm(directory, { recursive: true, force: true });
  }
});


test("cloud AI upscale publishes a separate image derivative with engine provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-cloud-ai-upscale-test-"));
  const previousBinary = process.env.REALESRGAN_NCNN_PATH;
  const previousModels = process.env.REALESRGAN_MODEL_DIR;
  const previousEnabled = process.env.AI_UPSCALE_ENABLED;
  const previousFfprobe = process.env.FFPROBE_PATH;
  const previousFfmpeg = process.env.FFMPEG_PATH;
  const source = join(directory, "source.png");
  const model = "realesrgan-x4plus";
  const binary = await executable(directory, "realesrgan-ncnn-vulkan", String.raw`while [ "$1" != "" ]; do if [ "$1" = "-o" ]; then shift; printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\001\000\000\000\001' > "$1"; fi; shift; done`);
  await writeFile(source, Buffer.from([137,80,78,71,13,10,26,10]));
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  process.env.REALESRGAN_NCNN_PATH = binary;
  process.env.REALESRGAN_MODEL_DIR = directory;
  process.env.AI_UPSCALE_ENABLED = "true";
  process.env.FFMPEG_PATH = await executable(directory, "ffmpeg", "exit 0");
  process.env.FFPROBE_PATH = await executable(directory, "ffprobe", "for last do :; done\ncase \"$last\" in *source.png) echo '{\"streams\":[{\"width\":10,\"height\":10}]}' ;; *) echo '{\"streams\":[{\"width\":40,\"height\":40}]}' ;; esac");
  let published;
  try {
    const execute = createCloudMediaExecutor({
      tempRoot: directory,
      mediaIO: {
        async materialize() {
          return { path: source, asset: { id: "image-source", name: "portrait.png", mediaType: "image/png", sha256: "d".repeat(64) }, async cleanup() {} };
        },
        async publish(args) {
          published = args;
          return { id: "image-ai-output", name: args.filename, mediaType: args.mediaType };
        }
      }
    });
    const result = await execute({
      job: { id: "job-ai-up", owner_id: "owner-ai", project_id: "project-ai", job_type: "media.ai-upscale",
        input: { sourceAssetId: "image-source", model, scale: 4, tile: 128, format: "png" } },
      onProgress() {}
    });
    assert.equal(result.processing.method, "ai-super-resolution");
    assert.equal(result.processing.engine, "realesrgan-ncnn-vulkan");
    assert.equal(result.processing.model, model);
    assert.equal(result.processing.scale, 4);
    assert.equal(result.processing.dimensionsVerified, true);
    assert.equal(result.processing.outputWidth, 40);
    assert.equal(result.processing.outputHeight, 40);
    assert.equal(published.derivativeOf, "image-source");
    assert.equal(published.mediaType, "image/png");
    assert.equal(published.metadata.processing.method, "ai-super-resolution");
  } finally {
    if (previousBinary === undefined) delete process.env.REALESRGAN_NCNN_PATH; else process.env.REALESRGAN_NCNN_PATH = previousBinary;
    if (previousModels === undefined) delete process.env.REALESRGAN_MODEL_DIR; else process.env.REALESRGAN_MODEL_DIR = previousModels;
    if (previousEnabled === undefined) delete process.env.AI_UPSCALE_ENABLED; else process.env.AI_UPSCALE_ENABLED = previousEnabled;
    if (previousFfprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousFfprobe;
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    await rm(directory, { recursive: true, force: true });
  }
});


test("cloud AI upscale blocks publication when output dimensions do not match", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-cloud-ai-upscale-mismatch-"));
  const previousBinary = process.env.REALESRGAN_NCNN_PATH;
  const previousModels = process.env.REALESRGAN_MODEL_DIR;
  const previousEnabled = process.env.AI_UPSCALE_ENABLED;
  const previousFfprobe = process.env.FFPROBE_PATH;
  const previousFfmpeg = process.env.FFMPEG_PATH;
  const source = join(directory, "source.png");
  const model = "realesrgan-x4plus";
  const binary = await executable(directory, "realesrgan-ncnn-vulkan", String.raw`while [ "$1" != "" ]; do if [ "$1" = "-o" ]; then shift; printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\001\000\000\000\001' > "$1"; fi; shift; done`);
  await writeFile(source, Buffer.from([137,80,78,71,13,10,26,10]));
  await writeFile(join(directory, model + ".param"), "model");
  await writeFile(join(directory, model + ".bin"), "weights");
  process.env.REALESRGAN_NCNN_PATH = binary;
  process.env.REALESRGAN_MODEL_DIR = directory;
  process.env.AI_UPSCALE_ENABLED = "true";
  process.env.FFMPEG_PATH = await executable(directory, "ffmpeg", "exit 0");
  process.env.FFPROBE_PATH = await executable(directory, "ffprobe", "case \"$last\" in *source.png) echo '{\"streams\":[{\"width\":10,\"height\":10}]}' ;; *) echo '{\"streams\":[{\"width\":40,\"height\":40}]}' ;; esac");
  let published;
  try {
    const execute = createCloudMediaExecutor({
      tempRoot: directory,
      mediaIO: {
        async materialize() {
          return { path: source, asset: { id: "image-source", name: "portrait.png", mediaType: "image/png", sha256: "d".repeat(64) }, async cleanup() {} };
        },
        async publish(args) {
          published = args;
          return { id: "image-ai-output", name: args.filename, mediaType: args.mediaType };
        }
      }
    });
    await assert.rejects(execute({
      job: { id: "job-ai-up-mismatch", owner_id: "owner-ai", project_id: "project-ai", job_type: "media.ai-upscale",
        input: { sourceAssetId: "image-source", model, scale: 4, tile: 128, format: "png" } },
      onProgress() {}
    }), error => error.code === "MEDIA_OUTPUT_VALIDATION_FAILED");
    assert.equal(published, undefined, "dimension-mismatched derivative must never be published");
  } finally {
    if (previousBinary === undefined) delete process.env.REALESRGAN_NCNN_PATH; else process.env.REALESRGAN_NCNN_PATH = previousBinary;
    if (previousModels === undefined) delete process.env.REALESRGAN_MODEL_DIR; else process.env.REALESRGAN_MODEL_DIR = previousModels;
    if (previousEnabled === undefined) delete process.env.AI_UPSCALE_ENABLED; else process.env.AI_UPSCALE_ENABLED = previousEnabled;
    if (previousFfprobe === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previousFfprobe;
    if (previousFfmpeg === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previousFfmpeg;
    await rm(directory, { recursive: true, force: true });
  }
});

test("cloud AI upscale rejects video instead of treating frame-by-frame resampling as AI video enhancement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-cloud-ai-video-reject-"));
  const source = join(directory, "source.mp4");
  await writeFile(source, "video-source");
  try {
    const execute = createCloudMediaExecutor({
      tempRoot: directory,
      mediaIO: {
        async materialize() { return { path: source, asset: { id: "video-source", name: "clip.mp4", mediaType: "video/mp4", sha256: "e".repeat(64) }, async cleanup() {} }; },
        async publish() { throw new Error("Unsupported video must not publish."); }
      }
    });
    await assert.rejects(execute({
      job: { id: "job-ai-video", owner_id: "owner", job_type: "media.ai-upscale", input: { sourceAssetId: "video-source" } },
      onProgress() {}
    }), error => error.code === "UNSUPPORTED_MEDIA_TYPE");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
