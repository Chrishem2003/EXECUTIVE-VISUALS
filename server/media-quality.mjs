import { buildMediaSignalFindings, buildAudioMetricFindings } from "./media-signal-analysis.mjs";
export function buildMediaQualityReport(metadata={},options={}) {
  const streams=Array.isArray(metadata.streams)?metadata.streams:[];
  const video=streams.filter(stream=>stream.codec_type==="video");
  const audio=streams.filter(stream=>stream.codec_type==="audio");
  const duration=Number(metadata.format?.duration);
  const findings=[];
  if(!streams.length)findings.push({code:"NO_STREAMS",severity:"error",message:"No readable media streams were found."});
  if(!Number.isFinite(duration)||duration<=0)findings.push({code:"INVALID_DURATION",severity:"error",message:"Media duration is missing or invalid."});
  if(options.requireVideo&&!video.length)findings.push({code:"VIDEO_STREAM_MISSING",severity:"error",message:"A video stream is required but was not found."});
  if(options.requireAudio&&!audio.length)findings.push({code:"AUDIO_STREAM_MISSING",severity:"warning",message:"No audio stream was found."});
  for(const [index,stream] of video.entries()){
    const width=Number(stream.width),height=Number(stream.height);
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)findings.push({code:"INVALID_VIDEO_DIMENSIONS",severity:"error",stream:index,message:"Video dimensions are missing or invalid."});
    else if(width<1280||height<720)findings.push({code:"BELOW_HD",severity:"warning",stream:index,message:"Video is below 720p; review delivery requirements."});
    const fps=String(stream.avg_frame_rate||stream.r_frame_rate||"").split("/");
    const numerator=Number(fps[0]),denominator=Number(fps[1]||1),rate=numerator/denominator;
    if(!Number.isFinite(rate)||rate<=0)findings.push({code:"INVALID_FRAME_RATE",severity:"warning",stream:index,message:"Video frame rate is missing or invalid."});
  }
  if(!video.length&&!audio.length)findings.push({code:"UNSUPPORTED_STREAM_LAYOUT",severity:"error",message:"No supported audio or video stream was found."});
  const signal=metadata.signalAnalysis||{};
  const signalFindings=buildMediaSignalFindings({blackFrames:signal.blackFrames||[],silence:signal.silence||[],freezes:signal.freezes||[],durationSeconds:Number.isFinite(duration)?duration:0});
  findings.push(...signalFindings,...buildAudioMetricFindings(signal.audioMetrics||{}));
  for(const item of signal.unavailable||[])findings.push({code:"SIGNAL_ANALYSIS_UNAVAILABLE",severity:"warning",check:item.check,reason:item.reason,message:"An optional signal-analysis check could not run; this result is unknown, not a clean pass."});
  const errors=findings.filter(item=>item.severity==="error").length;
  const warnings=findings.filter(item=>item.severity==="warning").length;
  return {
    schemaVersion:2,method:"ffprobe-and-ffmpeg-signal-analysis",durationSeconds:Number.isFinite(duration)&&duration>0?duration:null,
    streams:{total:streams.length,video:video.length,audio:audio.length},
    video:video.map(stream=>({codec:stream.codec_name||null,width:Number(stream.width)||null,height:Number(stream.height)||null,frameRate:stream.avg_frame_rate||stream.r_frame_rate||null})),
    audio:audio.map(stream=>({codec:stream.codec_name||null,sampleRate:Number(stream.sample_rate)||null,channels:Number(stream.channels)||null})),
    signalAnalysis:{method:signal.method||"not-run",performed:signal.performed||[],unavailable:signal.unavailable||[],blackFrameEvents:signal.blackFrames||[],silenceEvents:signal.silence||[],freezeEvents:signal.freezes||[],sceneChangeTimes:signal.sceneChanges||[],audioMetrics:signal.audioMetrics||null,voiceActivity:signal.voiceActivity||null},
    status:errors?"needs-attention":warnings?"review":"passed",counts:{errors,warnings},findings,
    limitations:[...(signal.limitations||[]),"Signal detection is heuristic; intentional black frames and silence may need human review.","Audio clipping and peak warnings use FFmpeg astats metrics; integrated loudness is reported when available but no universal delivery target is assumed.","True-peak compliance, synchronization, colour accuracy and perceptual quality are not assessed.","Scene-change timestamps are heuristic edit markers, not a semantic scene understanding or edit recommendation.","Voice activity detection is probabilistic speech-presence evidence, not transcription, speaker identification or a substitute for human review."]
  };
}
