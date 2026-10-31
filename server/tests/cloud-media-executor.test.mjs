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

test("cloud media probe uses the leased owner and cleans up its materialized source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ev-cloud-executor-test-"));
  const previous = process.env.FFPROBE_PATH;
  const source = join(directory, "source.mp4");
  await writeFile(source, "fixture");
  const ffprobe = await executable(directory, "ffprobe", "printf '%s' '{\"format\":{\"duration\":\"1.25\"}}'");
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
      job: { id: "job-1", owner_id: "verified-owner", project_id: "project-1", job_type: "media.probe", input_json: JSON.stringify({ sourceAssetId: "asset-1" }) },
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
  const source = join(directory, "source.mp4");
  await writeFile(source, "source-media");
  const ffmpeg = await executable(directory, "ffmpeg", 'for last do :; done\nprintf "rendered-media" > "$last"');
  process.env.FFMPEG_PATH = ffmpeg;
  let published, cleaned = false;
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
          return { id: "asset-output", name: args.filename, mediaType: args.mediaType };
        }
      }
    });
    const result = await execute({
      job: {
        id: "job-2", owner_id: "verified-owner", project_id: "project-2",
        job_type: "media.color",
        input_json: JSON.stringify({ sourceAssetId: "asset-source", brightness: 0.1, contrast: 1, saturation: 1 })
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
    assert.equal((await readFile(published.path, "utf8")), "rendered-media");
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previous;
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
