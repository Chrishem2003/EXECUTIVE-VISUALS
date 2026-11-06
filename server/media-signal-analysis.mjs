const parseEvents=(text,pattern,mapper)=>[...String(text||"").matchAll(pattern)].map(mapper);
export function parseBlackFrameEvents(stderr=""){
 return parseEvents(stderr,/black_start:([0-9.]+)\s+black_end:([0-9.]+)\s+black_duration:([0-9.]+)/g,match=>({startSeconds:Number(match[1]),endSeconds:Number(match[2]),durationSeconds:Number(match[3])})).filter(item=>Object.values(item).every(Number.isFinite));
}
export function parseSilenceEvents(stderr="",durationSeconds=0){
 const events=parseEvents(stderr,/silence_start:\s*([0-9.]+)[\s\S]*?silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/g,match=>({startSeconds:Number(match[1]),endSeconds:Number(match[2]),durationSeconds:Number(match[3])})).filter(item=>Object.values(item).every(Number.isFinite));
 const starts=[...String(stderr||"").matchAll(/silence_start:\s*([0-9.]+)/g)].map(match=>Number(match[1])).filter(Number.isFinite);
 const completed=new Set(events.map(event=>event.startSeconds));
 for(const startSeconds of starts){
  if(completed.has(startSeconds)||!Number.isFinite(durationSeconds)||durationSeconds<=startSeconds)continue;
  events.push({startSeconds,endSeconds:durationSeconds,durationSeconds:durationSeconds-startSeconds,trailing:true});
 }
 return events.sort((a,b)=>a.startSeconds-b.startSeconds);
}
export function parseFreezeEvents(stderr=""){
 const text=String(stderr||""),events=[];
 const starts=[...text.matchAll(/freeze_start:\s*([0-9.]+)/g)];
 for(const match of starts){
  const startSeconds=Number(match[1]),tail=text.slice(match.index);
  const end=tail.match(/freeze_end:\s*([0-9.]+)/),duration=tail.match(/freeze_duration:\s*([0-9.]+)/);
  if(end&&duration){const event={startSeconds,endSeconds:Number(end[1]),durationSeconds:Number(duration[1])};if(Object.values(event).every(Number.isFinite))events.push(event);}
 }
 return events;
}
export function parseSceneChangeTimes(stderr=""){
 return [...String(stderr||"").matchAll(/pts_time:\s*(-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))/g)].map(match=>Number(match[1])).filter(Number.isFinite);
}
export function buildMediaSignalFindings({blackFrames=[],silence=[],freezes=[],durationSeconds=0,blackThresholdSeconds=1,silenceThresholdSeconds=2,freezeThresholdSeconds=2}={}){
 const findings=[];
 for(const event of freezes){if(event.durationSeconds>=freezeThresholdSeconds)findings.push({code:"FROZEN_VIDEO_INTERVAL",severity:"warning",startSeconds:event.startSeconds,endSeconds:event.endSeconds,durationSeconds:event.durationSeconds,message:"A sustained low-motion interval was detected; review whether it is an intentional hold."});}
 for(const event of blackFrames){
  if(event.durationSeconds>=blackThresholdSeconds)findings.push({code:"SUSTAINED_BLACK_FRAME",severity:"warning",startSeconds:event.startSeconds,endSeconds:event.endSeconds,durationSeconds:event.durationSeconds,message:"Sustained black video interval detected; review whether intentional."});
 }
 for(const event of silence){
  if(event.durationSeconds>=silenceThresholdSeconds)findings.push({code:"SUSTAINED_SILENCE",severity:"warning",startSeconds:event.startSeconds,endSeconds:event.endSeconds,durationSeconds:event.durationSeconds,message:"Sustained audio silence detected; review whether intentional."});
 }
 const lastBlack=blackFrames.find(event=>event.endSeconds>=durationSeconds-0.15&&event.durationSeconds>=blackThresholdSeconds);
 if(lastBlack)findings.push({code:"BLACK_AT_END",severity:"warning",startSeconds:lastBlack.startSeconds,endSeconds:lastBlack.endSeconds,durationSeconds:lastBlack.durationSeconds,message:"The video ends in a sustained black interval."});
 return findings;
}

export function parseAudioMetrics(stderr=""){
 const text=String(stderr||"");
 const clipped=[...text.matchAll(/Number of samples clipped:\s*([0-9]+(?:\.[0-9]+)?)/g)].map(match=>Number(match[1])).filter(Number.isFinite);
 const peaks=[...text.matchAll(/Peak level dB:\s*(-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)|-inf)/gi)].map(match=>match[1].toLowerCase()==="-inf"?null:Number(match[1]));
 const rms=[...text.matchAll(/RMS level dB:\s*(-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)|-inf)/gi)].map(match=>match[1].toLowerCase()==="-inf"?null:Number(match[1]));
 const integrated=[...text.matchAll(/^\s*I:\s*(-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))\s*LUFS/gm)].map(match=>Number(match[1])).filter(Number.isFinite);
 const truePeaks=[...text.matchAll(/True peak:\s*Peak:\s*(-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)|-inf)\s*dBFS/gi)].map(match=>match[1].toLowerCase()==="-inf"?null:Number(match[1]));
 return {clippedSamples:clipped.length?Math.max(...clipped):null,peakDbfs:peaks.length?peaks.at(-1):null,truePeakDbfs:truePeaks.length?truePeaks.at(-1):null,rmsDbfs:rms.length?rms.at(-1):null,integratedLufs:integrated.length?integrated.at(-1):null};
}
export function buildAudioMetricFindings(metrics={}){
 const findings=[];
 if(Number(metrics.clippedSamples)>0)findings.push({code:"AUDIO_CLIPPING",severity:"warning",clippedSamples:Number(metrics.clippedSamples),message:"Clipped audio samples were reported by the signal analyzer."});
 if(Number.isFinite(metrics.peakDbfs)&&metrics.peakDbfs>=-1)findings.push({code:"AUDIO_PEAK_NEAR_FULL_SCALE",severity:"warning",peakDbfs:metrics.peakDbfs,message:"Audio sample peaks are within 1 dB of full scale; review delivery headroom."});
 if(Number.isFinite(metrics.truePeakDbfs)&&metrics.truePeakDbfs>=-1)findings.push({code:"AUDIO_TRUE_PEAK_NEAR_FULL_SCALE",severity:"warning",truePeakDbfs:metrics.truePeakDbfs,message:"Oversampled true peaks are within 1 dB of full scale; review inter-sample peak headroom."});
 return findings;
}

export async function runOptionalSignalCheck(check,{isCancelled=()=>false}={}) {
 try {
  return {status:"completed",result:await check()};
 } catch(error) {
  if(isCancelled())throw error;
  return {status:"unavailable",reason:String(error?.code||"ANALYSIS_FAILED").slice(0,80)};
 }
}
