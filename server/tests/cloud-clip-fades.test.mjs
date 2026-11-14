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

function sampleVideoBrightness(path, seconds) {
  const pixel = execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-ss", String(seconds), "-i", path,
    "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"
  ]);
  assert.equal(pixel.length, 3);
  return pixel[0] + pixel[1] + pixel[2];
}

function sampleAudioRms(path, seconds) {
  const pcm = execFileSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-i", path, "-ss", String(seconds), "-t", "0.05",
    "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1"
  ]);
  let sum = 0, count = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const value = pcm.readInt16LE(offset);
    sum += value * value;
    count++;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

test("cloud renderer applies clip-edge fades to final video and audio output", {
  skip: !hasFfmpeg || !hasFfprobe
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "ev-cloud-clip-fades-"));
  try {
    const video = join(root, "picture.mp4");
    const audio = join(root, "music.wav");
    execFileSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
      "-i", "color=c=red:s=320x240:r=24:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", video
    ]);
    execFileSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
      "-i", "sine=frequency=440:sample_rate=48000:duration=1", "-c:a", "pcm_s16le", audio
    ]);

    const timeline = {
      name: "Clip fade acceptance",
      width: 320,
      height: 240,
      frameRate: { numerator: 24, denominator: 1 },
      tracks: [
        { id: "video", kind: "video", clips: [{
          id: "picture", assetId: "picture", timelineStart: time(0), duration: time(1),
          sourceRange: { start: time(0), duration: time(1) },
          metadata: { fadeInSeconds: 0.25, fadeOutSeconds: 0.25 }
        }] },
        { id: "audio", kind: "audio", clips: [{
          id: "music", assetId: "music", timelineStart: time(0), duration: time(1),
          sourceRange: { start: time(0), duration: time(1) },
          metadata: { fadeInSeconds: 0.25, fadeOutSeconds: 0.25 }
        }] }
      ]
    };
    const assets = new Map([
      ["picture", { path: video, asset: { id: "picture", mediaType: "video/mp4", originalName: "picture.mp4" } }],
      ["music", { path: audio, asset: { id: "music", mediaType: "audio/wav", originalName: "music.wav" } }]
    ]);

    const result = await renderCloudTimeline({ timeline, assets, workDir: root, onProgress() {} });
    assert.equal(result.render.clipFadeClips, 2);
    const probe = JSON.parse(execFileSync(ffprobe, [
      "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", result.path
    ], { encoding: "utf8" }));
    assert.ok(probe.streams.some(stream => stream.codec_type === "video"));
    assert.ok(probe.streams.some(stream => stream.codec_type === "audio"));

    const earlyVideo = sampleVideoBrightness(result.path, 0.05);
    const middleVideo = sampleVideoBrightness(result.path, 0.5);
    const lateVideo = sampleVideoBrightness(result.path, 0.95);
    assert.ok(middleVideo > earlyVideo * 2, "video fade-in should be visible in decoded output");
    assert.ok(middleVideo > lateVideo * 2, "video fade-out should be visible in decoded output");

    const earlyAudio = sampleAudioRms(result.path, 0.05);
    const middleAudio = sampleAudioRms(result.path, 0.5);
    const lateAudio = sampleAudioRms(result.path, 0.95);
    assert.ok(middleAudio > earlyAudio * 2, "audio fade-in should be visible in decoded output");
    assert.ok(middleAudio > lateAudio * 2, "audio fade-out should be visible in decoded output");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
