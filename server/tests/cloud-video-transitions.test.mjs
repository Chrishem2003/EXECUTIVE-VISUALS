import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCloudTimeline } from "../cloud-ffmpeg-timeline-renderer.mjs";

const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
const hasFfmpeg = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;
const hasFfprobe = spawnSync(ffprobe, ["-version"], { stdio: "ignore" }).status === 0;
const time = value => ({ value, rate: 1 });

for (const transition of ["wipeleft", "slideup"]) {
  test("cloud renderer produces a valid master with " + transition + " transition", {
    skip: !hasFfmpeg || !hasFfprobe
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "ev-video-transition-"));
    try {
      const outgoing = join(root, "outgoing.mp4");
      const incoming = join(root, "incoming.mp4");
      execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", outgoing]);
      execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", incoming]);
      const timeline = {
        name: "Directional transition acceptance",
        width: 320,
        height: 240,
        frameRate: { numerator: 24, denominator: 1 },
        tracks: [{
          id: "video",
          kind: "video",
          enabled: true,
          clips: [
            { id: "out", assetId: "out", timelineStart: time(0), duration: time(1), sourceRange: { start: time(0), duration: time(1) }, enabled: true, transitionToNext: { type: transition, fadeFrames: 12 } },
            { id: "in", assetId: "in", timelineStart: time(0.5), duration: time(1), sourceRange: { start: time(0), duration: time(1) }, enabled: true }
          ]
        }]
      };
      const assets = new Map([
        ["out", { path: outgoing, asset: { id: "out", mediaType: "video/mp4", originalName: "outgoing.mp4" } }],
        ["in", { path: incoming, asset: { id: "in", mediaType: "video/mp4", originalName: "incoming.mp4" } }]
      ]);
      const result = await renderCloudTimeline({ timeline, assets, workDir: root, onProgress() {} });
      const probe = JSON.parse(execFileSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "json", result.path], { encoding: "utf8" }));
      assert.ok(Math.abs(Number(probe.format.duration) - 1.5) < 0.08, "transition render should preserve the expected 1.5 second sequence duration");
      assert.equal(result.render.videoClips, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
