export type AudioAutomationProperty = "gainDb" | "pan";
export interface AudioAutomationPoint { timeSeconds:number; gainDb?:number; pan?:number; interpolation?:"linear"|"step" }
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
export function normalizeAudioAutomation(points:readonly AudioAutomationPoint[]|undefined):AudioAutomationPoint[]{
 if(points===undefined)return [];
 if(!Array.isArray(points)||points.length>256)throw new Error("Audio automation supports at most 256 keyframes per clip.");
 const sorted=points.map(point=>{
  if(!point||!Number.isFinite(point.timeSeconds)||point.timeSeconds<0||point.timeSeconds>86400)throw new Error("Audio automation keyframe time must be between 0 and 86400 seconds.");
  const next:AudioAutomationPoint={timeSeconds:Number(point.timeSeconds),interpolation:point.interpolation==="step"?"step":"linear"};
  if(point.gainDb!==undefined){if(!Number.isFinite(point.gainDb))throw new Error("Audio automation gain must be finite.");next.gainDb=clamp(point.gainDb,-60,24);}
  if(point.pan!==undefined){if(!Number.isFinite(point.pan))throw new Error("Audio automation pan must be finite.");next.pan=clamp(point.pan,-1,1);}
  if(next.gainDb===undefined&&next.pan===undefined)throw new Error("Audio automation keyframe must define gain or pan.");
  return next;
 }).sort((a,b)=>a.timeSeconds-b.timeSeconds);
 for(let i=1;i<sorted.length;i++)if(sorted[i].timeSeconds===sorted[i-1].timeSeconds)throw new Error("Audio automation keyframe times must be unique.");
 return sorted;
}
export function evaluateAudioAutomation(points:readonly AudioAutomationPoint[]|undefined,timeSeconds:number,property:AudioAutomationProperty,fallback:number):number{
 const relevant=normalizeAudioAutomation(points).filter(point=>point[property]!==undefined),time=Math.max(0,Number.isFinite(timeSeconds)?timeSeconds:0);
 if(!relevant.length)return fallback;
 let previousTime=0,previousValue=fallback;
 for(const point of relevant){
  const nextValue=point[property] as number;
  if(time<point.timeSeconds){
   if(point.interpolation==="linear"&&point.timeSeconds>previousTime){const ratio=clamp((time-previousTime)/(point.timeSeconds-previousTime),0,1);return previousValue+(nextValue-previousValue)*ratio;}
   return previousValue;
  }
  previousTime=point.timeSeconds;previousValue=nextValue;
 }
 return previousValue;
}
const number=(value:number)=>Number(value.toFixed(9)).toString();
export function buildGainAutomationExpression(points:readonly AudioAutomationPoint[]|undefined,baseGainDb=0):string{
 const relevant=normalizeAudioAutomation(points).filter(point=>point.gainDb!==undefined),gain=(db:number)=>Math.pow(10/1,clamp(db,-60,24)/20);
 if(!relevant.length)return number(gain(baseGainDb));
 let expression=number(gain(relevant[relevant.length-1].gainDb as number));
 for(let index=relevant.length-1;index>=0;index--){
  const point=relevant[index],to=point.timeSeconds,from=index?relevant[index-1].timeSeconds:0;
  const fromValue=index?gain(relevant[index-1].gainDb as number):gain(baseGainDb),toValue=gain(point.gainDb as number);
  const segment=point.interpolation==="linear"&&to>from?"("+number(fromValue)+"+("+number(toValue)+"-"+number(fromValue)+")*((t-"+number(from)+")/("+number(to)+"-"+number(from)+")))":number(fromValue);
  expression="if(lt(t,"+number(to)+"),"+segment+","+expression+")";
 }
 return expression;
}


export interface AudioDuckingInterval { startSeconds:number; endSeconds:number }
export interface AudioDuckingOptions { attenuationDb?:number; attackSeconds?:number; releaseSeconds?:number; mergeGapSeconds?:number }

/**
 * Build editable gain automation that lowers a music clip under explicitly
 * selected dialogue intervals. Existing pan automation is retained.
 */
export function createAudioDuckingAutomation(
 existing:readonly AudioAutomationPoint[]|undefined,
 musicStartSeconds:number,
 musicDurationSeconds:number,
 voiceIntervals:readonly AudioDuckingInterval[],
 baseGainDb=0,
 options:AudioDuckingOptions={}
):AudioAutomationPoint[]{
 if(!Number.isFinite(musicStartSeconds)||!Number.isFinite(musicDurationSeconds)||musicStartSeconds<0||musicDurationSeconds<=0)
  throw new Error("Music clip timing must be finite, non-negative and have a positive duration.");
 if(!Number.isFinite(baseGainDb))throw new Error("Music base gain must be finite.");
 const attenuation=options.attenuationDb??12,attack=options.attackSeconds??0.12,release=options.releaseSeconds??0.3,mergeGap=options.mergeGapSeconds??0.15;
 if(!Number.isFinite(attenuation)||attenuation<0||attenuation>36||!Number.isFinite(attack)||attack<0.01||attack>2||
    !Number.isFinite(release)||release<0.01||release>5||!Number.isFinite(mergeGap)||mergeGap<0||mergeGap>2)
  throw new Error("Ducking reduction, attack, release or merge-gap setting is outside its supported range.");
 const end=musicStartSeconds+musicDurationSeconds;
 const intervals=voiceIntervals.map(item=>{
  if(!Number.isFinite(item.startSeconds)||!Number.isFinite(item.endSeconds)||item.endSeconds<=item.startSeconds)
   throw new Error("Dialogue intervals must have finite, increasing start and end times.");
  return {start:Math.max(musicStartSeconds,item.startSeconds),end:Math.min(end,item.endSeconds)};
 }).filter(item=>item.end>item.start).sort((a,b)=>a.start-b.start);
 if(!intervals.length)throw new Error("The selected dialogue track does not overlap this music clip.");
 const merged:Array<{start:number;end:number}>=[];
 for(const item of intervals){
  const previous=merged.at(-1);
  if(previous&&item.start-previous.end<=mergeGap)previous.end=Math.max(previous.end,item.end);
  else merged.push({...item});
 }
 const base=Math.max(-60,Math.min(24,baseGainDb)),ducked=Math.max(-60,base-attenuation);
 const generated:AudioAutomationPoint[]=[];
 for(const interval of merged){
  const start=interval.start-musicStartSeconds,finish=interval.end-musicStartSeconds;
  const alreadySpeaking=interval.start<=musicStartSeconds;
  const continuesPastClip=interval.end>=end;
  if(alreadySpeaking)generated.push({timeSeconds:0,gainDb:ducked});
  else generated.push({timeSeconds:Number(start.toFixed(4)),gainDb:base});
  const attackLength=Math.min(attack,Math.max(0,(finish-start)/2));
  if(!alreadySpeaking&&attackLength>0)generated.push({timeSeconds:Number((start+attackLength).toFixed(4)),gainDb:ducked});
  if(continuesPastClip)continue;
  const releaseLength=Math.min(release,Math.max(0,(finish-start)/2));
  if(releaseLength>0)generated.push({timeSeconds:Number((finish-releaseLength).toFixed(4)),gainDb:ducked});
  generated.push({timeSeconds:Number(finish.toFixed(4)),gainDb:base});
 }
 const panPoints=normalizeAudioAutomation(existing).filter(point=>point.pan!==undefined).map(point=>({timeSeconds:point.timeSeconds,pan:point.pan,interpolation:point.interpolation}));
 const combined=new Map<number,AudioAutomationPoint>();
 for(const point of panPoints)combined.set(point.timeSeconds,{...point});
 for(const point of generated){
  const previous=combined.get(point.timeSeconds);
  combined.set(point.timeSeconds,{...previous,...point,timeSeconds:point.timeSeconds});
 }
 return normalizeAudioAutomation([...combined.values()]);
}
