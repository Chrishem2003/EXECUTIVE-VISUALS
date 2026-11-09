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


export function parseTemporalLumaSamples(stderr=""){
 const samples=[];
 for(const block of String(stderr||"").split(/(?=frame:\s*\d+\s+pts:)/g)){
  const frame=block.match(/frame:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*(-?(?:\d+(?:\.\d*)?|\.\d+))/);
  const read=key=>{const match=block.match(new RegExp("lavfi\\.signalstats\\."+key+"\\s*=\\s*(-?(?:\\d+(?:\\.\\d*)?|\\.\\d+))"));return match?Number(match[1]):null;};
  const meanLuma=read("YAVG");
  if(!frame||!Number.isFinite(meanLuma)||meanLuma<0||meanLuma>255)continue;
  const sample={frame:Number(frame[1]),pts:Number(frame[2]),timeSeconds:Number(frame[3]),meanLuma};
  for(const [key,property] of [["SATAVG","meanSaturation"],["UAVG","meanU"],["VAVG","meanV"],["YMIN","minLuma"],["YMAX","maxLuma"],["YDIF","lumaDifference"],["UDIF","uDifference"],["VDIF","vDifference"]]){
   const value=read(key);if(Number.isFinite(value))sample[property]=value;
  }
  if(Object.values(sample).every(Number.isFinite))samples.push(sample);
 }
 return samples.sort((a,b)=>a.timeSeconds-b.timeSeconds||a.frame-b.frame);
}

export function buildTemporalColorFindings({samples=[],sceneChanges=[],minSaturationDelta=18,minChromaDelta=20,minAlternatingTransitions=3,sceneCutExclusionSeconds=0.75,maxSampleGapSeconds=0.5}={}){
 const ordered=(Array.isArray(samples)?samples:[]).filter(sample=>sample&&Number.isFinite(sample.timeSeconds)&&Number.isFinite(sample.meanSaturation)&&Number.isFinite(sample.meanU)&&Number.isFinite(sample.meanV)).sort((a,b)=>a.timeSeconds-b.timeSeconds);
 const cuts=(Array.isArray(sceneChanges)?sceneChanges:[]).filter(Number.isFinite);
 const deltas=[];
 for(let i=1;i<ordered.length;i++){
  const previous=ordered[i-1],current=ordered[i],elapsed=current.timeSeconds-previous.timeSeconds;
  if(elapsed<=0||elapsed>maxSampleGapSeconds)continue;
  const midpoint=(previous.timeSeconds+current.timeSeconds)/2;
  if(cuts.some(cut=>Math.abs(cut-midpoint)<=sceneCutExclusionSeconds))continue;
  deltas.push({index:i-1,startSeconds:previous.timeSeconds,endSeconds:current.timeSeconds,saturation:current.meanSaturation-previous.meanSaturation,u:current.meanU-previous.meanU,v:current.meanV-previous.meanV});
 }
 const findings=[];
 for(const [kind,readDelta,threshold,code,message] of [
  ["saturation",item=>item.saturation,minSaturationDelta,"ALTERNATING_SATURATION_INSTABILITY","Repeated alternating frame-average saturation changes were detected; inspect this interval for color pumping."],
  ["chroma",item=>Math.hypot(item.u,item.v),minChromaDelta,"ALTERNATING_CHROMA_INSTABILITY","Repeated alternating frame-average chroma shifts were detected; inspect this interval for color flicker."]
 ]){
  for(let i=0;i<deltas.length;){
   const first=deltas[i],firstDelta=readDelta(first);
   if(!Number.isFinite(firstDelta)||Math.abs(firstDelta)<threshold){i++;continue;}
   let j=i+1,last=firstDelta,transitions=1,maxDelta=Math.abs(firstDelta);
   while(j<deltas.length){
    const current=deltas[j],previous=deltas[j-1],value=readDelta(current);
    if(current.index!==previous.index+1||!Number.isFinite(value)||Math.abs(value)<threshold)break;
    if(kind==="saturation"&&Math.sign(value)===Math.sign(last))break;
    if(kind==="chroma"){
     const dot=previous.u*current.u+previous.v*current.v;
     const previousMagnitude=Math.hypot(previous.u,previous.v),currentMagnitude=Math.hypot(current.u,current.v);
     if(dot>=-0.35*previousMagnitude*currentMagnitude)break;
    }
    transitions++;last=value;maxDelta=Math.max(maxDelta,Math.abs(value));j++;
   }
   if(transitions>=minAlternatingTransitions){
    findings.push({code,severity:"warning",startSeconds:first.startSeconds,endSeconds:deltas[j-1].endSeconds,transitions,maxDelta:Number(maxDelta.toFixed(3)),message});
    i=j;
   }else i++;
  }
 }
 return findings.sort((a,b)=>a.startSeconds-b.startSeconds);
}

export function buildTemporalLumaFindings({samples=[],sceneChanges=[],minJump=65,minAlternatingDelta=30,minAlternatingTransitions=3,sceneCutExclusionSeconds=0.75}={}){
 const ordered=(Array.isArray(samples)?samples:[]).filter(sample=>sample&&Number.isFinite(sample.timeSeconds)&&Number.isFinite(sample.meanLuma)&&sample.meanLuma>=0&&sample.meanLuma<=255).sort((a,b)=>a.timeSeconds-b.timeSeconds);
 const cuts=(Array.isArray(sceneChanges)?sceneChanges:[]).filter(Number.isFinite);
 const deltas=[];
 for(let i=1;i<ordered.length;i++){
  const previous=ordered[i-1],current=ordered[i],elapsed=current.timeSeconds-previous.timeSeconds;
  if(elapsed<=0||elapsed>2)continue;
  const midpoint=(previous.timeSeconds+current.timeSeconds)/2;
  if(cuts.some(cut=>Math.abs(cut-midpoint)<=sceneCutExclusionSeconds))continue;
  deltas.push({index:i-1,startSeconds:previous.timeSeconds,endSeconds:current.timeSeconds,delta:current.meanLuma-previous.meanLuma});
 }
 const findings=[],covered=new Set();
 for(let i=0;i<deltas.length;){
  const first=deltas[i];
  if(Math.abs(first.delta)<minAlternatingDelta){i++;continue;}
  let j=i+1,lastSign=Math.sign(first.delta),transitions=1,maxDelta=Math.abs(first.delta);
  while(j<deltas.length){
   const current=deltas[j],previous=deltas[j-1];
   if(current.index!==previous.index+1||Math.abs(current.delta)<minAlternatingDelta||Math.sign(current.delta)===lastSign)break;
   transitions++;lastSign=Math.sign(current.delta);maxDelta=Math.max(maxDelta,Math.abs(current.delta));j++;
  }
  if(transitions>=minAlternatingTransitions){
   for(let k=i;k<j;k++)covered.add(deltas[k].index);
   findings.push({code:"ALTERNATING_LUMINANCE_INSTABILITY",severity:"warning",startSeconds:first.startSeconds,endSeconds:deltas[j-1].endSeconds,transitions,maxDelta,message:"Repeated alternating frame-average brightness changes were detected; inspect this interval for exposure pumping or visible flicker."});
   i=j;
  }else i++;
 }
 for(const item of deltas){
  if(covered.has(item.index)||Math.abs(item.delta)<minJump)continue;
  findings.push({code:"ABRUPT_LUMINANCE_CHANGE",severity:"warning",startSeconds:item.startSeconds,endSeconds:item.endSeconds,delta:item.delta,message:"A large frame-average brightness change was detected; confirm that it is an intentional lighting or exposure transition."});
 }
 return findings.sort((a,b)=>a.startSeconds-b.startSeconds);
}
