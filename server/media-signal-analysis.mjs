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
 return {clippedSamples:clipped.length?Math.max(...clipped):null,peakDbfs:peaks.length?peaks.at(-1):null,rmsDbfs:rms.length?rms.at(-1):null,integratedLufs:integrated.length?integrated.at(-1):null};
}
export function buildAudioMetricFindings(metrics={}){
 const findings=[];
 if(Number(metrics.clippedSamples)>0)findings.push({code:"AUDIO_CLIPPING",severity:"warning",clippedSamples:Number(metrics.clippedSamples),message:"Clipped audio samples were reported by the signal analyzer."});
 if(Number.isFinite(metrics.peakDbfs)&&metrics.peakDbfs>=-1)findings.push({code:"AUDIO_PEAK_NEAR_FULL_SCALE",severity:"warning",peakDbfs:metrics.peakDbfs,message:"Audio peaks are within 1 dB of full scale; review true-peak and delivery headroom."});
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

/**
 * Derive non-silence activity windows from FFmpeg silence intervals.
 * This is an amplitude heuristic, not speech recognition or voice-activity classification.
 */
export function buildNonSilenceActivityIntervals({silence=[],durationSeconds=0,minActivitySeconds=0.15,padSeconds=0.08,maxIntervals=128}={}){
 if(!Number.isFinite(durationSeconds)||durationSeconds<=0)throw new Error("Audio duration must be a positive finite value.");
 if(!Number.isFinite(minActivitySeconds)||minActivitySeconds<0||minActivitySeconds>10)throw new Error("Minimum activity duration is outside the supported range.");
 if(!Number.isFinite(padSeconds)||padSeconds<0||padSeconds>2)throw new Error("Activity padding is outside the supported range.");
 if(!Number.isInteger(maxIntervals)||maxIntervals<1||maxIntervals>1024)throw new Error("Activity interval limit is outside the supported range.");
 const normalized=silence.map(event=>{
  if(!event||!Number.isFinite(event.startSeconds)||!Number.isFinite(event.endSeconds)||event.endSeconds<event.startSeconds)throw new Error("Silence intervals must contain finite ordered timestamps.");
  return {start:Math.max(0,Math.min(durationSeconds,event.startSeconds)),end:Math.max(0,Math.min(durationSeconds,event.endSeconds))};
 }).filter(event=>event.end>event.start).sort((a,b)=>a.start-b.start);
 const merged=[];
 for(const event of normalized){const last=merged[merged.length-1];if(last&&event.start<=last.end)last.end=Math.max(last.end,event.end);else merged.push({...event});}
 const active=[];let cursor=0;
 for(const event of merged){if(event.start>cursor)active.push({startSeconds:cursor,endSeconds:event.start});cursor=Math.max(cursor,event.end);}
 if(cursor<durationSeconds)active.push({startSeconds:cursor,endSeconds:durationSeconds});
 return active.map(event=>({startSeconds:Math.max(0,Number((event.startSeconds-padSeconds).toFixed(4))),endSeconds:Math.min(durationSeconds,Number((event.endSeconds+padSeconds).toFixed(4)))}))
  .map(event=>({...event,durationSeconds:Number((event.endSeconds-event.startSeconds).toFixed(4))}))
  .filter(event=>event.durationSeconds>=minActivitySeconds)
  .reduce((result,event)=>{
   const last=result[result.length-1];
   if(last&&event.startSeconds<=last.endSeconds){last.endSeconds=Math.max(last.endSeconds,event.endSeconds);last.durationSeconds=Number((last.endSeconds-last.startSeconds).toFixed(4));}
   else result.push(event);
   return result;
  },[]).slice(0,maxIntervals);
}
