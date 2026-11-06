const PROFILES = Object.freeze({
  "social-vertical": { id:"social-vertical", label:"Social vertical", width:1080, height:1920, fps:{numerator:30,denominator:1}, videoCodec:"h264", pixelFormat:"yuv420p", crf:20, preset:"veryfast", audioCodec:"aac", audioBitrate:"192k", sampleRate:48000, requireAudio:true },
  "youtube-1080p": { id:"youtube-1080p", label:"YouTube 1080p", width:1920, height:1080, fps:{numerator:30,denominator:1}, videoCodec:"h264", pixelFormat:"yuv420p", crf:19, preset:"medium", audioCodec:"aac", audioBitrate:"192k", sampleRate:48000, requireAudio:true },
  "youtube-4k": { id:"youtube-4k", label:"YouTube 4K", width:3840, height:2160, fps:{numerator:30,denominator:1}, videoCodec:"h264", pixelFormat:"yuv420p", crf:18, preset:"slow", audioCodec:"aac", audioBitrate:"320k", sampleRate:48000, requireAudio:true },
  "broadcast-1080p25": { id:"broadcast-1080p25", label:"Broadcast 1080p25 review preset", width:1920, height:1080, fps:{numerator:25,denominator:1}, videoCodec:"h264", pixelFormat:"yuv420p", crf:18, preset:"slow", audioCodec:"aac", audioBitrate:"320k", sampleRate:48000, requireAudio:true, targetIntegratedLufs:-23, lufsTolerance:1 },
  "instagram-square": { id:"instagram-square", label:"Instagram square", width:1080, height:1080, fps:{numerator:30,denominator:1}, videoCodec:"h264", pixelFormat:"yuv420p", crf:20, preset:"veryfast", audioCodec:"aac", audioBitrate:"192k", sampleRate:48000, requireAudio:true },
  "social-landscape": { id:"social-landscape", label:"Social landscape", width:1920, height:1080, fps:{numerator:30,denominator:1}, videoCodec:"h264", pixelFormat:"yuv420p", crf:20, preset:"veryfast", audioCodec:"aac", audioBitrate:"192k", sampleRate:48000, requireAudio:true },
  "youtube-1440p": { id:"youtube-1440p", label:"YouTube 1440p", width:2560, height:1440, fps:{numerator:30,denominator:1}, videoCodec:"h264", pixelFormat:"yuv420p", crf:19, preset:"medium", audioCodec:"aac", audioBitrate:"256k", sampleRate:48000, requireAudio:true },
  "web-720p": { id:"web-720p", label:"Web lightweight 720p", width:1280, height:720, fps:{numerator:30,denominator:1}, videoCodec:"h264", pixelFormat:"yuv420p", crf:23, preset:"veryfast", audioCodec:"aac", audioBitrate:"128k", sampleRate:48000, requireAudio:true }
});

export function listDeliveryProfiles() {
  return Object.values(PROFILES).map(profile=>structuredClone(profile));
}

export function getDeliveryProfile(profileId) {
  const profile=PROFILES[String(profileId||"")];
  if(!profile)throw Object.assign(new Error("Unknown delivery profile."),{code:"DELIVERY_PROFILE_UNKNOWN"});
  return structuredClone(profile);
}

export function evaluateDeliveryOutput(metadata={},profileId) {
  const profile=getDeliveryProfile(profileId),streams=Array.isArray(metadata.streams)?metadata.streams:[];
  const video=streams.find(stream=>stream.codec_type==="video"),audio=streams.find(stream=>stream.codec_type==="audio"),findings=[];
  const add=(code,severity,message)=>findings.push({code,severity,message});
  if(!video)add("VIDEO_STREAM_MISSING","error","The export has no video stream.");
  else {
    if(Number(video.width)!==profile.width||Number(video.height)!==profile.height)add("VIDEO_DIMENSIONS_MISMATCH","error",`Expected ${profile.width}×${profile.height}; received ${video.width||"unknown"}×${video.height||"unknown"}.`);
    if(String(video.codec_name||"").toLowerCase()!==profile.videoCodec)add("VIDEO_CODEC_MISMATCH","error",`Expected ${profile.videoCodec}; received ${video.codec_name||"unknown"}.`);
    if(String(video.pix_fmt||"")!==profile.pixelFormat)add("PIXEL_FORMAT_MISMATCH","error",`Expected ${profile.pixelFormat}; received ${video.pix_fmt||"unknown"}.`);
    const [n,d]=String(video.avg_frame_rate||"").split("/").map(Number),actual=n/d,expected=profile.fps.numerator/profile.fps.denominator;
    if(!Number.isFinite(actual)||Math.abs(actual-expected)>0.01)add("FRAME_RATE_MISMATCH","error",`Expected ${expected} fps; received ${Number.isFinite(actual)?actual:"unknown"}.`);
  }
  if(profile.requireAudio&&!audio)add("AUDIO_STREAM_MISSING","error","This delivery profile requires an audio stream.");
  if(audio) {
    if(String(audio.codec_name||"").toLowerCase()!==profile.audioCodec)add("AUDIO_CODEC_MISMATCH","error",`Expected ${profile.audioCodec}; received ${audio.codec_name||"unknown"}.`);
    if(Number(audio.sample_rate)!==profile.sampleRate)add("AUDIO_SAMPLE_RATE_MISMATCH","error",`Expected ${profile.sampleRate} Hz; received ${audio.sample_rate||"unknown"}.`);
  }
  const duration=Number(metadata.format?.duration);
  if(!Number.isFinite(duration)||duration<=0)add("INVALID_DURATION","error","The exported file has no valid positive duration.");
  const lufs=Number(metadata.signalAnalysis?.audioMetrics?.integratedLufs);
  if(profile.targetIntegratedLufs!==undefined) {
    if(!Number.isFinite(lufs))add("LOUDNESS_UNAVAILABLE","warning","Integrated loudness was not measured; manual review is required.");
    else if(Math.abs(lufs-profile.targetIntegratedLufs)>profile.lufsTolerance)add("LOUDNESS_OUT_OF_TARGET","warning",`Measured ${lufs} LUFS; target is ${profile.targetIntegratedLufs} ± ${profile.lufsTolerance} LU.`);
  }
  const errors=findings.filter(item=>item.severity==="error").length,warnings=findings.filter(item=>item.severity==="warning").length;
  return {schemaVersion:1,profileId:profile.id,profileLabel:profile.label,status:errors?"needs-attention":warnings?"review":"passed",counts:{errors,warnings},findings,limitations:["This report validates container metadata and declared profile targets, not visual or perceptual quality.","A codec/profile pass does not establish broadcaster or platform acceptance; confirm current delivery specifications with the recipient.","Loudness is only assessed when a measured integrated LUFS value is supplied."]};
}
