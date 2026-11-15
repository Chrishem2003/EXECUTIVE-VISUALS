export type MotionProperty="x"|"y"|"width"|"height"|"opacity"|"rotation";
export type MotionPlaybackMode="none"|"loop"|"ping-pong";
export interface MotionKeyframe {
 timeSeconds:number;
 interpolation?:"linear"|"step"|"ease-in"|"ease-out"|"ease-in-out";
 x?:number;y?:number;width?:number;height?:number;opacity?:number;rotation?:number;
}
const LIMITS:Record<MotionProperty,[number,number]>={x:[-16384,16384],y:[-16384,16384],width:[16,16384],height:[16,16384],opacity:[0,1],rotation:[-3600,3600]};
export function normalizeMotionKeyframes(points:readonly MotionKeyframe[]|undefined,durationSeconds:number):MotionKeyframe[]{
 if(points===undefined)return [];
 if(!Array.isArray(points)||points.length>256)throw new Error("Motion animation supports at most 256 keyframes per clip.");
 if(!Number.isFinite(durationSeconds)||durationSeconds<=0)throw new Error("Motion clip duration must be positive and finite.");
 const sorted=points.map(point=>{
  if(!point||!Number.isFinite(point.timeSeconds)||point.timeSeconds<0||point.timeSeconds>durationSeconds)throw new Error("Motion keyframe time must stay inside its clip.");
  const next:MotionKeyframe={timeSeconds:Number(point.timeSeconds.toFixed(4)),interpolation:point.interpolation==="step"||point.interpolation==="ease-in"||point.interpolation==="ease-out"||point.interpolation==="ease-in-out"?point.interpolation:"linear"};
  let count=0;
  for(const property of Object.keys(LIMITS) as MotionProperty[]){
   const value=point[property];if(value===undefined)continue;
   if(!Number.isFinite(value))throw new Error("Motion keyframe values must be finite.");
   const [min,max]=LIMITS[property];next[property]=Math.max(min,Math.min(max,Number(value)));count++;
  }
  if(!count)throw new Error("Motion keyframe must define at least one animated property.");
  return next;
 }).sort((a,b)=>a.timeSeconds-b.timeSeconds);
 for(let index=1;index<sorted.length;index++)if(sorted[index].timeSeconds===sorted[index-1].timeSeconds)throw new Error("Motion keyframe times must be unique.");
 return sorted;
}
function easeMotionRatio(ratio:number,mode:MotionKeyframe["interpolation"]){const t=Math.max(0,Math.min(1,ratio));if(mode==="ease-in")return t*t*t;if(mode==="ease-out")return 1-Math.pow(1-t,3);if(mode==="ease-in-out")return t*t*(3-2*t);return t;}
export function evaluateMotionProperty(points:readonly MotionKeyframe[]|undefined,timeSeconds:number,property:MotionProperty,fallback:number,durationSeconds:number):number{
 const keys=normalizeMotionKeyframes(points,durationSeconds).filter(point=>point[property]!==undefined),time=Math.max(0,Math.min(durationSeconds,Number.isFinite(timeSeconds)?timeSeconds:0));
 if(!keys.length)return fallback;
 let previousTime=0,previousValue=fallback;
 for(const point of keys){
  const value=point[property] as number;
  if(time<point.timeSeconds){
   if(point.interpolation==="step"||point.timeSeconds<=previousTime)return previousValue;
   const ratio=easeMotionRatio((time-previousTime)/(point.timeSeconds-previousTime),point.interpolation);
   return previousValue+(value-previousValue)*ratio;
  }
  previousTime=point.timeSeconds;previousValue=value;
 }
 return previousValue;
}
export function evaluateMotionKeyframes(points:readonly MotionKeyframe[]|undefined,timeSeconds:number,base:{x:number;y:number;width:number;height:number;opacity:number;rotation:number},durationSeconds:number,playbackMode:MotionPlaybackMode="none"){
 const keys=normalizeMotionKeyframes(points,durationSeconds),first=keys[0]?.timeSeconds??0,last=keys[keys.length-1]?.timeSeconds??0,span=last-first;let time=timeSeconds;
 if(span>0&&Number.isFinite(time)&&time>=first){const elapsed=time-first;if(playbackMode==="loop")time=first+((elapsed%span)+span)%span;else if(playbackMode==="ping-pong"){const cycle=((elapsed%(span*2))+span*2)%(span*2);time=first+(cycle<=span?cycle:span*2-cycle);}}
 return {x:evaluateMotionProperty(points,time,"x",base.x,durationSeconds),y:evaluateMotionProperty(points,time,"y",base.y,durationSeconds),width:evaluateMotionProperty(points,time,"width",base.width,durationSeconds),height:evaluateMotionProperty(points,time,"height",base.height,durationSeconds),opacity:evaluateMotionProperty(points,time,"opacity",base.opacity,durationSeconds),rotation:evaluateMotionProperty(points,time,"rotation",base.rotation,durationSeconds)};
}
