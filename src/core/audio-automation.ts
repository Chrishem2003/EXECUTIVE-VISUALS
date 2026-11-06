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
