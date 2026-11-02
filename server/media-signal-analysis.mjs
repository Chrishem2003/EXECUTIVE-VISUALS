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
 const truePeaks=[...text.matchAll(/True peak:\s*(-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))\s*dBFS/gi)].map(match=>Number(match[1])).filter(Number.isFinite);
 return {clippedSamples:clipped.length?Math.max(...clipped):null,peakDbfs:peaks.length?peaks.at(-1):null,truePeakDbtp:truePeaks.length?truePeaks.at(-1):null,rmsDbfs:rms.length?rms.at(-1):null,integratedLufs:integrated.length?integrated.at(-1):null};
}
export function buildAudioMetricFindings(metrics={}){
 const findings=[];
 if(Number(metrics.clippedSamples)>0)findings.push({code:"AUDIO_CLIPPING",severity:"warning",clippedSamples:Number(metrics.clippedSamples),message:"Clipped audio samples were reported by the signal analyzer."});
 if(Number.isFinite(metrics.peakDbfs)&&metrics.peakDbfs>=-1)findings.push({code:"AUDIO_PEAK_NEAR_FULL_SCALE",severity:"warning",peakDbfs:metrics.peakDbfs,message:"Sample peaks are within 1 dB of full scale; review true-peak and delivery headroom."});
 if(Number.isFinite(metrics.truePeakDbtp)&&metrics.truePeakDbtp>=-1)findings.push({code:"AUDIO_TRUE_PEAK_NEAR_LIMIT",severity:"warning",truePeakDbtp:metrics.truePeakDbtp,message:"Measured true peak is above -1 dBTP; review the delivery headroom requirement."});
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
 * Parse FFmpeg signalstats metadata=print output into bounded per-frame
 * luma samples. Missing timestamps/values are discarded rather than guessed.
 */
export function parseVideoLumaSamples(stderr=""){
 const samples=[];
 const blocks=String(stderr||"").split(/(?=^frame:\s*\d+)/m);
 for(const block of blocks){
  const frame=block.match(/^frame:\s*(\d+)/m);
  const time=block.match(/(?:^|\n)pts_time:\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/);
  const luma=block.match(/(?:^|\n)lavfi\.signalstats\.YAVG=([0-9]+(?:\.[0-9]+)?)/);
  if(!frame||!time||!luma)continue;
  const sample={frame:Number(frame[1]),timeSeconds:Number(time[1]),meanLuma:Number(luma[1])};
  if(Number.isSafeInteger(sample.frame)&&Number.isFinite(sample.timeSeconds)&&sample.timeSeconds>=0&&Number.isFinite(sample.meanLuma)&&sample.meanLuma>=0&&sample.meanLuma<=255)samples.push(sample);
 }
 return samples.sort((a,b)=>a.timeSeconds-b.timeSeconds||a.frame-b.frame);
}

/**
 * Conservative temporal luminance anomaly detector. Scene-cut-adjacent
 * changes are excluded; findings are review prompts, never quality scores.
 */
export function buildTemporalLumaFindings({lumaSamples=[],sceneChanges=[],minimumDelta=30,sceneGuardSeconds=0.18,alternatingWindow=4,alternatingMinimumDelta=18}={}){
 const samples=Array.isArray(lumaSamples)?lumaSamples.filter(item=>Number.isFinite(item?.timeSeconds)&&item.timeSeconds>=0&&Number.isFinite(item?.meanLuma)&&item.meanLuma>=0&&item.meanLuma<=255).sort((a,b)=>a.timeSeconds-b.timeSeconds):[];
 const cuts=Array.isArray(sceneChanges)?sceneChanges.filter(Number.isFinite):[];
 const deltas=[];
 for(let i=1;i<samples.length;i++){
  const previous=samples[i-1],current=samples[i],delta=current.meanLuma-previous.meanLuma;
  if(current.timeSeconds<=previous.timeSeconds)continue;
  const nearCut=cuts.some(time=>Math.abs(time-current.timeSeconds)<=sceneGuardSeconds);
  deltas.push({startSeconds:previous.timeSeconds,endSeconds:current.timeSeconds,delta,nearCut});
 }
 const findings=[];
 for(const item of deltas){
  if(!item.nearCut&&Math.abs(item.delta)>=minimumDelta)findings.push({code:"ABRUPT_LUMA_CHANGE",severity:"warning",startSeconds:item.startSeconds,endSeconds:item.endSeconds,lumaDelta:Number(item.delta.toFixed(2)),message:"A large frame-to-frame luminance change was detected away from a known scene cut; review for a flash, exposure jump or intentional lighting change."});
 }
 const eligible=deltas.filter(item=>!item.nearCut);
 for(let i=alternatingWindow-1;i<eligible.length;i++){
  const window=eligible.slice(i-alternatingWindow+1,i+1);
  if(window.some(item=>Math.abs(item.delta)<alternatingMinimumDelta))continue;
  const signs=window.map(item=>Math.sign(item.delta));
  if(signs.every((sign,index)=>index===0||sign!==signs[index-1])){
   const startSeconds=window[0].startSeconds,endSeconds=window.at(-1).endSeconds;
   if(!findings.some(item=>item.code==="TEMPORAL_LUMA_FLICKER"&&Math.abs(item.startSeconds-startSeconds)<0.0001))
    findings.push({code:"TEMPORAL_LUMA_FLICKER",severity:"warning",startSeconds,endSeconds,frameTransitions:window.length,message:"Repeated alternating frame luminance changes may indicate flicker; inspect this interval visually."});
  }
 }
 return findings.sort((a,b)=>a.startSeconds-b.startSeconds);
}
