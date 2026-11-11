export type AudioAutomationProperty = "gainDb" | "pan";
export interface AudioAutomationPoint {
 timeSeconds:number;
 gainDb?:number;
 pan?:number;
 interpolation?:"linear"|"step";
}
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
export function parseAudioAutomationEditorInput(raw:string,durationSeconds:number):AudioAutomationPoint[]{
 let parsed:unknown;
 try{parsed=JSON.parse(raw.trim()||"[]");}catch{throw new Error("Audio automation must be valid JSON.");}
 if(!Array.isArray(parsed))throw new Error("Audio automation must be a JSON array.");
 if(!Number.isFinite(durationSeconds)||durationSeconds<0)throw new Error("Audio automation clip duration is invalid.");
 const points=normalizeAudioAutomation(parsed as AudioAutomationPoint[]);
 if(points.some(point=>point.timeSeconds>durationSeconds))throw new Error("Audio automation keyframes must fall inside the edited clip duration.");
 return points;
}
export function audioAutomationPointFromGraphPosition(xRatio:number,yRatio:number,durationSeconds:number,pan=0):AudioAutomationPoint{
 if(!Number.isFinite(durationSeconds)||durationSeconds<=0)throw new Error("Audio automation clip duration must be positive.");
 const x=Math.max(0,Math.min(1,Number.isFinite(xRatio)?xRatio:0));
 const y=Math.max(0,Math.min(1,Number.isFinite(yRatio)?yRatio:0));
 return {timeSeconds:Number((x*durationSeconds).toFixed(4)),gainDb:Number((24-y*84).toFixed(2)),pan:Math.max(-1,Math.min(1,Number.isFinite(pan)?pan:0)),interpolation:"linear"};
}
export function evaluateAudioAutomation(points:readonly AudioAutomationPoint[]|undefined,timeSeconds:number,property:AudioAutomationProperty,fallback:number):number{
 const safe=normalizeAudioAutomation(points),time=Math.max(0,Number.isFinite(timeSeconds)?timeSeconds:0);
 const relevant=safe.filter(point=>point[property]!==undefined);
 if(!relevant.length)return fallback;
 let previousTime=0,previousValue=fallback;
 for(const point of relevant){
  const nextValue=point[property] as number;
  if(time<point.timeSeconds){
   if(point.interpolation==="linear"&&point.timeSeconds>previousTime){
    const ratio=clamp((time-previousTime)/(point.timeSeconds-previousTime),0,1);
    return previousValue+(nextValue-previousValue)*ratio;
   }
   return previousValue;
  }
  previousTime=point.timeSeconds;previousValue=nextValue;
 }
 return previousValue;
}
const number=(value:number)=>Number(value.toFixed(9)).toString();
export function buildAudioAutomationExpression(points:readonly AudioAutomationPoint[]|undefined,property:AudioAutomationProperty,fallback:number):string{
 const relevant=normalizeAudioAutomation(points).filter(point=>point[property]!==undefined);
 if(!relevant.length)return number(fallback);
 let expression=number(relevant[relevant.length-1][property] as number);
 for(let index=relevant.length-1;index>=0;index--){
  const point=relevant[index],to=point.timeSeconds;
  const from=index?relevant[index-1].timeSeconds:0;
  const fromValue=index?relevant[index-1][property] as number:fallback;
  const toValue=point[property] as number;
  const segment=point.interpolation==="linear"&&to>from
   ?`(${number(fromValue)}+(${number(toValue)}-(${number(fromValue)}))*((t-${number(from)})/(${number(to)}-${number(from)})))`
   :number(fromValue);
  expression=`if(lt(t,${number(to)}),${segment},${expression})`;
 }
 return expression;
}
export function buildGainAutomationExpression(points:readonly AudioAutomationPoint[]|undefined,baseGainDb=0):string{
 const relevant=normalizeAudioAutomation(points).filter(point=>point.gainDb!==undefined);
 if(!relevant.length)return number(decibelsToLinearGain(baseGainDb));
 let expression=number(decibelsToLinearGain(relevant[relevant.length-1].gainDb as number));
 for(let index=relevant.length-1;index>=0;index--){
  const point=relevant[index],to=point.timeSeconds,from=index?relevant[index-1].timeSeconds:0;
  const fromDb=index?relevant[index-1].gainDb as number:baseGainDb,toDb=point.gainDb as number;
  const fromValue=decibelsToLinearGain(fromDb),toValue=decibelsToLinearGain(toDb);
  const segment=point.interpolation==="linear"&&to>from
   ?`(${number(fromValue)}+(${number(toValue)}-(${number(fromValue)}))*((t-${number(from)})/(${number(to)}-${number(from)})))`
   :number(fromValue);
  expression=`if(lt(t,${number(to)}),${segment},${expression})`;
 }
 return expression;
}
export function audioPanExpressions(points:readonly AudioAutomationPoint[]|undefined,basePan=0):{left:string;right:string}{
 const pan=buildAudioAutomationExpression(points,"pan",clamp(Number.isFinite(basePan)?basePan:0,-1,1));
 return {left:`if(gt((${pan}),0),1-(${pan}),1)`,right:`if(lt((${pan}),0),1+(${pan}),1)`};
}
export function decibelsToLinearGain(value:number):number{
 const db=clamp(Number.isFinite(value)?value:0,-60,24);return Math.pow(10,db/20);
}

export interface DialogueActivityRange {startSeconds:number;endSeconds:number;}

export interface SourceActivityInterval {startSeconds:number;endSeconds:number;}
export interface SourceClipTiming {
 sourceStartSeconds:number;
 sourceDurationSeconds:number;
 timelineStartSeconds:number;
 timelineDurationSeconds:number;
 speed?:number;
 speedCurve?:readonly {timeSeconds:number;speed:number}[];
}
function speedAt(curve:readonly {timeSeconds:number;speed:number}[]|undefined,time:number,fallback:number):number{
 if(!curve?.length)return fallback;
 if(time<=curve[0].timeSeconds)return curve[0].speed;
 for(let i=1;i<curve.length;i++){const left=curve[i-1],right=curve[i];if(time<=right.timeSeconds){const span=right.timeSeconds-left.timeSeconds;return span<=0?right.speed:left.speed+(right.speed-left.speed)*(time-left.timeSeconds)/span;}}
 return curve[curve.length-1].speed;
}
function integrateSourceTime(curve:readonly {timeSeconds:number;speed:number}[]|undefined,time:number,fallback:number):number{
 const end=Math.max(0,time);if(!curve?.length)return end*fallback;
 const boundaries=[0,...curve.map(point=>point.timeSeconds).filter(value=>value>0&&value<end),end].sort((a,b)=>a-b);
 let total=0;for(let i=1;i<boundaries.length;i++){const a=boundaries[i-1],b=boundaries[i];total+=(speedAt(curve,a,fallback)+speedAt(curve,b,fallback))*.5*(b-a);}
 return total;
}
function timelineTimeForSourceElapsed(curve:readonly {timeSeconds:number;speed:number}[]|undefined,target:number,duration:number,fallback:number):number{
 let low=0,high=duration;for(let i=0;i<48;i++){const middle=(low+high)/2;if(integrateSourceTime(curve,middle,fallback)<target)low=middle;else high=middle;}return(high+low)/2;
}
/** Maps source-file activity timestamps through trim and speed remapping into absolute timeline intervals. */
export function mapSourceActivityToTimelineRanges(intervals:readonly SourceActivityInterval[],clip:SourceClipTiming):DialogueActivityRange[]{
 const values=[clip.sourceStartSeconds,clip.sourceDurationSeconds,clip.timelineStartSeconds,clip.timelineDurationSeconds,clip.speed??1];
 if(values.some(value=>!Number.isFinite(value))||clip.sourceStartSeconds<0||clip.sourceDurationSeconds<=0||clip.timelineStartSeconds<0||clip.timelineDurationSeconds<=0||clip.speed!==undefined&&(clip.speed<.25||clip.speed>4))throw new Error("Dialogue source clip timing is invalid.");
 const fallback=clip.speed??1,curve=clip.speedCurve;
 if(curve!==undefined&&(!Array.isArray(curve)||curve.length<2||curve.length>64||curve[0]?.timeSeconds!==0||curve.some((point,index)=>!point||!Number.isFinite(point.timeSeconds)||!Number.isFinite(point.speed)||point.speed<.25||point.speed>4||point.timeSeconds<0||point.timeSeconds>clip.timelineDurationSeconds||(index>0&&point.timeSeconds<=curve[index-1].timeSeconds))))throw new Error("Dialogue source speed curve is invalid.");
 const mappedSourceDuration=integrateSourceTime(curve,clip.timelineDurationSeconds,fallback);
 if(Math.abs(mappedSourceDuration-clip.sourceDurationSeconds)>Math.max(.02,clip.sourceDurationSeconds*.02))throw new Error("Dialogue source and timeline clip durations do not match the speed mapping.");
 const sourceEnd=clip.sourceStartSeconds+clip.sourceDurationSeconds;
 const output:DialogueActivityRange[]=[];
 for(const interval of intervals){
  if(!interval||!Number.isFinite(interval.startSeconds)||!Number.isFinite(interval.endSeconds)||interval.startSeconds<0||interval.endSeconds<=interval.startSeconds)throw new Error("Analyzed audio activity intervals must be finite positive source-time ranges.");
  const start=Math.max(clip.sourceStartSeconds,interval.startSeconds),end=Math.min(sourceEnd,interval.endSeconds);
  if(end<=start)continue;
  const localStart=timelineTimeForSourceElapsed(curve,start-clip.sourceStartSeconds,clip.timelineDurationSeconds,fallback);
  const localEnd=timelineTimeForSourceElapsed(curve,end-clip.sourceStartSeconds,clip.timelineDurationSeconds,fallback);
  if(localEnd>localStart)output.push({startSeconds:Number((clip.timelineStartSeconds+localStart).toFixed(4)),endSeconds:Number((clip.timelineStartSeconds+localEnd).toFixed(4))});
 }
 return output.sort((a,b)=>a.startSeconds-b.startSeconds);
}

export interface DialogueDuckingOptions {
 musicStartSeconds:number;
 musicDurationSeconds:number;
 dialogueRanges:readonly DialogueActivityRange[];
 baseGainDb?:number;
 duckingDb?:number;
 attackMs?:number;
 releaseMs?:number;
 existing?:readonly AudioAutomationPoint[];
}
/** Builds clip-relative gain keyframes from dialogue clip activity, preserving existing pan points. */
export function buildDialogueDuckingAutomation(options:DialogueDuckingOptions):AudioAutomationPoint[]{
 const {musicStartSeconds,musicDurationSeconds}=options;
 if(!Number.isFinite(musicStartSeconds)||musicStartSeconds<0||!Number.isFinite(musicDurationSeconds)||musicDurationSeconds<=0)throw new Error("Music clip start and duration must be valid positive timeline values.");
 const base=clamp(Number.isFinite(options.baseGainDb)?options.baseGainDb as number:0,-60,24);
 const reduction=clamp(Number.isFinite(options.duckingDb)?options.duckingDb as number:-12,-36,0);
 const attack=clamp(Number.isFinite(options.attackMs)?options.attackMs as number:120,0,5000)/1000;
 const release=clamp(Number.isFinite(options.releaseMs)?options.releaseMs as number:350,0,10000)/1000;
 const musicEnd=musicStartSeconds+musicDurationSeconds;
 const ranges=options.dialogueRanges.map(range=>{
  if(!range||!Number.isFinite(range.startSeconds)||!Number.isFinite(range.endSeconds)||range.startSeconds<0||range.endSeconds<=range.startSeconds)throw new Error("Dialogue activity ranges must have finite, positive timeline intervals.");
  return {start:Math.max(musicStartSeconds,range.startSeconds),end:Math.min(musicEnd,range.endSeconds),alreadyActiveAtMusicStart:range.startSeconds<musicStartSeconds};
 }).filter(range=>range.end>range.start).sort((a,b)=>a.start-b.start);
 const merged:Array<{start:number;end:number;alreadyActiveAtMusicStart:boolean}>=[];
 for(const range of ranges){const previous=merged[merged.length-1];if(previous&&range.start<=previous.end+release){previous.end=Math.max(previous.end,range.end);previous.alreadyActiveAtMusicStart=previous.alreadyActiveAtMusicStart||range.alreadyActiveAtMusicStart;}else merged.push({...range});}
 const generated:AudioAutomationPoint[]=[];
 const push=(time:number,gain:number)=>generated.push({timeSeconds:Number(clamp(time,0,musicDurationSeconds).toFixed(4)),gainDb:clamp(gain,-60,24),interpolation:"linear"});
 for(const range of merged){
  const start=range.start-musicStartSeconds,end=range.end-musicStartSeconds,target=clamp(base+reduction,-60,24);
  if(start>0)push(start,base);else push(0,range.alreadyActiveAtMusicStart?target:(attack>0?base:target));
  const attackEnd=Math.min(end,start+attack);
  if(attackEnd>start)push(attackEnd,target);
  push(end,target);
  if(end<musicDurationSeconds&&release>0)push(Math.min(musicDurationSeconds,end+release),base);
  else if(end<musicDurationSeconds)push(end,base);
 }
 const unique=new Map<number,AudioAutomationPoint>();
 for(const point of generated)unique.set(point.timeSeconds,point);
 const panOnly=(options.existing??[]).filter(point=>point.pan!==undefined).map(point=>({timeSeconds:point.timeSeconds,pan:point.pan,interpolation:point.interpolation}));
 for(const point of panOnly){const at=point.timeSeconds,existing=unique.get(at);unique.set(at,{...existing,...point});}
 return normalizeAudioAutomation([...unique.values()]);
}
