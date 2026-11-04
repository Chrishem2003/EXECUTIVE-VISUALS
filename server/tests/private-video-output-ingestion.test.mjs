import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateVideoOutputIngestor, createFfprobeVideoOutputValidator } from "../private-video-output-ingestion.mjs";

const ownerId = "123e4567-e89b-42d3-a456-426614174000";
const projectId = "223e4567-e89b-42d3-a456-426614174000";
const task = { taskId: "runway-task-1", outputUrls: ["https://cdn.example.test/video.mp4"] };
const config = {
  allowedHosts: ["cdn.example.test"],
  resolver: async () => [{ address: "93.184.216.34", family: 4 }],
  download: async (_url, _path, options) => ({ size: 1024, contentType: "video/mp4", pinnedAddress: options.address?.address }),
  validateMedia: async () => ({ valid: true, mediaType: "video/mp4", metadata: { durationSeconds: 5 } })
};
function assetRepo({ failOn = -1, cleanupFails = false, cleanupPending = false } = {}) {
  const created = [], removed = [];
  return {
    created, removed,
    async findVideoGenerationOutput({ ownerId: lookupOwner, projectId: lookupProject, providerTaskId, outputIndex }) {
      return created.find(asset => !removed.some(item => item.assetId === asset.id) &&
        asset.ownerId === lookupOwner && (asset.projectId || null) === (lookupProject || null) &&
        asset.value.metadata?.providerTaskId === providerTaskId &&
        asset.value.metadata?.outputIndex === outputIndex) || null;
    },
    async createFromFile(value) {
      if (created.length === failOn) throw new Error("storage registration failed");
      const asset = {
        id: `323e4567-e89b-42d3-a456-42661417400${created.length + 1}`,
        ownerId: value.ownerId, projectId: value.projectId, mediaType: value.mediaType, size: 1024, value
      };
      created.push(asset);
      return asset;
    },
    async softDelete(value) {
      removed.push(value);
      if (cleanupFails) throw new Error("cleanup failed");
      return { deleted: true, storageRemoved: !cleanupPending, cleanupPending };
    }
  };
}

test("downloads only from allowlisted HTTPS hosts, validates, and registers private assets", async () => {
  const assets = assetRepo();
  const calls = [];
  const ingest = createPrivateVideoOutputIngestor({
    ...config, assets,
    download: async (url, path, options) => {
      calls.push({ url: url.href, path, address: options.address });
      return { size: 1024, contentType: "video/mp4" };
    }
  });
  const result = await ingest.ingest({
    job: { id: "job-1", owner_id: ownerId, project_id: projectId },
    task, input: { provider: "runway", model: "gen4.5" }
  });
  assert.equal(result.assetIds.length, 1);
  assert.equal(result.assetIds[0], assets.created[0].id);
  assert.equal(assets.created[0].value.ownerId, ownerId);
  assert.equal(assets.created[0].value.projectId, projectId);
  assert.equal(assets.created[0].value.metadata.validated, true);
  assert.equal(assets.created[0].value.metadata.outputIndex, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address.address, "93.184.216.34");
});

test("reuses the existing private asset for a repeated provider task and output index", async () => {
  const assets = assetRepo();
  const ingest = createPrivateVideoOutputIngestor({ ...config, assets });
  const request = {
    job: { owner_id: ownerId, project_id: projectId },
    task, input: { provider: "runway", model: "gen4.5" }
  };
  const first = await ingest.ingest(request);
  const second = await ingest.ingest(request);
  assert.deepEqual(second.assetIds, first.assetIds);
  assert.equal(assets.created.length, 1);
  assert.equal(second.usage.totalBytes, 1024);
});

test("does not delete a previously registered idempotent asset when a later output fails", async () => {
  const assets = assetRepo({ failOn: 1 });
  const ingest = createPrivateVideoOutputIngestor({ ...config, assets });
  const firstRequest = {
    job: { owner_id: ownerId, project_id: projectId },
    task, input: { provider: "runway", model: "gen4.5" }
  };
  const first = await ingest.ingest(firstRequest);
  await assert.rejects(ingest.ingest({
    ...firstRequest,
    task: { ...task, outputUrls: [task.outputUrls[0], task.outputUrls[0]] }
  }), /storage registration failed/);
  assert.equal(assets.removed.length, 0);
  assert.equal(assets.created[0].id, first.assetIds[0]);
});

test("rejects non-allowlisted, non-HTTPS, credentialed, and nonstandard-port URLs before DNS or download", async () => {
  let resolves = 0, downloads = 0;
  const ingest = createPrivateVideoOutputIngestor({
    ...config, assets: assetRepo(),
    resolver: async () => { resolves++; return [{ address: "93.184.216.34", family: 4 }]; },
    download: async () => { downloads++; return { size: 1, contentType: "video/mp4" }; }
  });
  for (const url of [
    "https://attacker.test/file.mp4",
    "http://cdn.example.test/file.mp4",
    "https://user:pass@cdn.example.test/file.mp4",
    "https://cdn.example.test:8443/file.mp4"
  ]) {
    await assert.rejects(ingest.ingest({
      job: { owner_id: ownerId, project_id: projectId },
      task: { ...task, outputUrls: [url] }, input: {}
    }), error => error.code === "VIDEO_OUTPUT_URL_REJECTED");
  }
  assert.equal(resolves, 0);
  assert.equal(downloads, 0);
});

test("rejects private, loopback, link-local, and mixed public/private DNS answers", async () => {
  for (const addresses of [
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "10.0.0.5", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "::1", family: 6 }],
    [{ address: "fc00::1", family: 6 }],
    [{ address: "fe80::1", family: 6 }],
    [{ address: "::ffff:7f00:1", family: 6 }],
    [{ address: "2001:db8::1", family: 6 }],
    [{ address: "2002:5db8:d822::1", family: 6 }],
    [{ address: "93.184.216.34", family: 4 }, { address: "192.168.1.2", family: 4 }]
  ]) {
    const ingest = createPrivateVideoOutputIngestor({
      ...config, assets: assetRepo(), resolver: async () => addresses,
      download: async () => { throw new Error("must not download"); }
    });
    await assert.rejects(ingest.ingest({
      job: { owner_id: ownerId, project_id: projectId }, task, input: {}
    }), error => error.code === "VIDEO_OUTPUT_HOST_NOT_PUBLIC");
  }
});

test("accepts generic binary MIME only when the media validator identifies a real video", async () => {
  const assets = assetRepo();
  const ingest = createPrivateVideoOutputIngestor({
    ...config, assets,
    download: async () => ({ size: 1024, contentType: "application/octet-stream" }),
    validateMedia: async () => ({ valid: true, mediaType: "video/mp4" })
  });
  const result = await ingest.ingest({
    job: { owner_id: ownerId, project_id: projectId }, task, input: {}
  });
  assert.equal(result.assetIds.length, 1);
});

test("fails closed when media validation rejects content even when HTTP MIME looks valid", async () => {
  const assets = assetRepo();
  const ingest = createPrivateVideoOutputIngestor({
    ...config, assets,
    validateMedia: async () => ({ valid: false, mediaType: "video/mp4" })
  });
  await assert.rejects(ingest.ingest({
    job: { owner_id: ownerId, project_id: projectId }, task, input: {}
  }), error => error.code === "VIDEO_OUTPUT_MEDIA_INVALID");
  assert.equal(assets.created.length, 0);
});

test("rolls back previously registered private assets if a later output fails", async () => {
  const assets = assetRepo({ failOn: 1 });
  const ingest = createPrivateVideoOutputIngestor({
    ...config, assets,
    download: async () => ({ size: 1024, contentType: "video/mp4" })
  });
  await assert.rejects(ingest.ingest({
    job: { owner_id: ownerId, project_id: projectId },
    task: { ...task, outputUrls: [task.outputUrls[0], task.outputUrls[0]] }, input: {}
  }), /storage registration failed/);
  assert.equal(assets.removed.length, 1);
  assert.equal(assets.removed[0].assetId, assets.created[0].id);
});

test("reports cleanup pending if rollback cannot remove a previously registered private asset", async () => {
  const assets = assetRepo({ failOn: 1, cleanupFails: true });
  const ingest = createPrivateVideoOutputIngestor({
    ...config, assets,
    download: async () => ({ size: 1024, contentType: "video/mp4" })
  });
  await assert.rejects(ingest.ingest({
    job: { owner_id: ownerId, project_id: projectId },
    task: { ...task, outputUrls: [task.outputUrls[0], task.outputUrls[0]] }, input: {}
  }), error => error.cleanupPending === true);
});

test("propagates a soft-delete receipt when private object removal remains pending", async () => {
  const assets = assetRepo({ failOn: 1, cleanupPending: true });
  const ingest = createPrivateVideoOutputIngestor({
    ...config, assets,
    download: async () => ({ size: 1024, contentType: "video/mp4" })
  });
  await assert.rejects(ingest.ingest({
    job: { owner_id: ownerId, project_id: projectId },
    task: { ...task, outputUrls: [task.outputUrls[0], task.outputUrls[0]] }, input: {}
  }), error => error.cleanupPending === true);
});

test("requires explicit allowlist, media validator, and private asset cleanup support", () => {
  assert.throws(() => createPrivateVideoOutputIngestor({ assets: assetRepo(), validateMedia: async () => ({ valid: true }) }), /allowlist/);
  assert.throws(() => createPrivateVideoOutputIngestor({ assets: assetRepo(), allowedHosts: ["cdn.example.test"] }), /media validation/);
  assert.throws(() => createPrivateVideoOutputIngestor({
    assets: { createFromFile: async () => ({}), findVideoGenerationOutput: async () => null }, allowedHosts: ["cdn.example.test"], validateMedia: async () => ({ valid: true })
  }), /softDelete/);
});

test("enforces job ownership, output count and bounded response sizes", async () => {
  const ingest = createPrivateVideoOutputIngestor({
    ...config, assets: assetRepo(), maxBytesPerOutput: 1024, maxTotalBytes: 1024,
    download: async () => ({ size: 1025, contentType: "video/mp4" })
  });
  await assert.rejects(ingest.ingest({ job: { owner_id: "bad" }, task, input: {} }), error => error.code === "VIDEO_OUTPUT_JOB_SCOPE_INVALID");
  await assert.rejects(ingest.ingest({
    job: { owner_id: ownerId, project_id: projectId },
    task: { ...task, outputUrls: Array(11).fill(task.outputUrls[0]) }, input: {}
  }), error => error.code === "VIDEO_OUTPUT_COLLECTION_INVALID");
  await assert.rejects(ingest.ingest({
    job: { owner_id: ownerId, project_id: projectId }, task, input: {}
  }), error => error.code === "VIDEO_OUTPUT_DOWNLOAD_INVALID");
});

test("FFprobe validator accepts bounded MP4 video and returns inspected stream metadata", async () => {
  let invoked = null;
  const validator = createFfprobeVideoOutputValidator({
    ffprobePath: "/tools/ffprobe",
    execFileImpl(command, args, options, callback) {
      invoked = { command, args, options };
      callback(null, JSON.stringify({
        format: { duration: "12.5", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
        streams: [
          { codec_type: "video", codec_name: "h264", width: 1920, height: 1080 },
          { codec_type: "audio", codec_name: "aac" }
        ]
      }), "");
    }
  });
  const result = await validator({ path: "/tmp/output.mp4", contentType: "video/mp4", size: 1024 });
  assert.equal(result.valid, true);
  assert.equal(result.mediaType, "video/mp4");
  assert.equal(result.metadata.durationSeconds, 12.5);
  assert.equal(result.metadata.width, 1920);
  assert.equal(invoked.command, "/tools/ffprobe");
  assert.ok(invoked.args.includes("-show_entries"));
  assert.equal(invoked.options.shell, undefined);
});

test("FFprobe validator rejects audio-only, malformed, overlong and MIME-mismatched outputs", async () => {
  const outputs = [
    { format: { duration: "12", format_name: "mp4" }, streams: [{ codec_type: "audio" }] },
    { format: { duration: "9999", format_name: "mp4" }, streams: [{ codec_type: "video", width: 1920, height: 1080 }] },
    { format: { duration: "12", format_name: "webm" }, streams: [{ codec_type: "video", width: 1920, height: 1080 }] },
    { format: { duration: "12", format_name: "mp4" }, streams: [{ codec_type: "video", width: 99999, height: 99999 }] }
  ];
  for (const output of outputs) {
    const validator = createFfprobeVideoOutputValidator({
      execFileImpl(_command, _args, _options, callback) { callback(null, JSON.stringify(output), ""); }
    });
    const result = await validator({ path: "/tmp/output", contentType: "video/mp4", size: 1024 });
    assert.equal(result.valid, false);
  }
  const mismatch = createFfprobeVideoOutputValidator({
    execFileImpl(_command, _args, _options, callback) {
      callback(null, JSON.stringify({
        format: { duration: "12", format_name: "webm" },
        streams: [{ codec_type: "video", width: 1280, height: 720 }]
      }), "");
    }
  });
  assert.equal((await mismatch({ path: "/tmp/output", contentType: "video/mp4", size: 1024 })).reason, "MIME_CONTAINER_MISMATCH");
});

test("FFprobe validator fails closed when the binary is missing or output is malformed", async () => {
  const failed = createFfprobeVideoOutputValidator({
    execFileImpl(_command, _args, _options, callback) { callback(new Error("not found")); }
  });
  assert.equal((await failed({ path: "/tmp/output", contentType: "video/mp4", size: 1024 })).reason, "FFPROBE_FAILED");
  const malformed = createFfprobeVideoOutputValidator({
    execFileImpl(_command, _args, _options, callback) { callback(null, "not-json", ""); }
  });
  assert.equal((await malformed({ path: "/tmp/output", contentType: "video/mp4", size: 1024 })).reason, "FFPROBE_INVALID_JSON");
});
