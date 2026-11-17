// Shared contract for cloud media workers and executors. Keep this list as the
// single source of truth so newly supported operations cannot be enqueued but
// silently left unclaimed by the worker.
export const CLOUD_MEDIA_JOB_TYPES = Object.freeze([
  "media.probe",
  "media.thumbnail",
  "media.audio_extract",
  "media.audio-clean",
  "media.audio-master",
  "media.audio_replace",
  "media.denoise",
  "media.color",
  "media.resize",
  "media.interpolate",
  "media.upscale",
  "media.ai-upscale",
  "media.video-ai-upscale",
  "media.transcode",
  "media.proxy"
]);
