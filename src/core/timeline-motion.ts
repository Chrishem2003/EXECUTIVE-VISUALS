export type MotionProperty="x"|"y"|"width"|"height"|"opacity"|"rotation";
export type MotionPlaybackMode="none"|"loop"|"ping-pong";
export interface MotionKeyframe {
 timeSeconds:number;
 interpolation?:"linear"|"step"|"ease-in"|"ease-out"|"ease-in-out"|"bezier";
 bezier?:{x1:number;y1:number;x2:number;y2:number};
 x?:number;y?:number;width?:number;height?:number;opacity?:number;rotation?:number;
}
const LIMITS:Record<MotionProperty,[number,number]>={x:[-16384,16384],y:[-16384,16384],width:[16,16384],height:[16,16384],opacity:[0,1],rotation:[-3600,3600]};
export function normalizeMotionKeyframes(points:readonly MotionKeyframe[]|undefined,durationSeconds:number):MotionKeyframe[]{
 if(points===undefined)return [];
 if(!Array.isArray(points)||points.length>256)throw new Error("Motion animation supports at most 256 keyframes per clip.");
 if(!Number.isFinite(durationSeconds)||durationSeconds<=0)throw new Error("Motion clip duration must be positive and finite.");
 const sorted=points.map(point=>{
  if(!point||!Number.isFinite(point.timeSeconds)||point.timeSeconds<0||point.timeSeconds>durationSeconds)throw new Error("Motion keyframe time must stay inside its clip.");
  const interpolation=point.interpolation==="step"||point.interpolation==="ease-in"||point.interpolation==="ease-out"||point.interpolation==="ease-in-out"||point.interpolation==="bezier"?point.interpolation:"linear";
  const next:MotionKeyframe={timeSeconds:Number(point.timeSeconds.toFixed(4)),interpolation};
  if(interpolation==="bezier"){
   const curve=point.bezier??{x1:0.25,y1:0.1,x2:0.25,y2:1};
   const {x1,y1,x2,y2}=curve;
   if(![x1,y1,x2,y2].every(Number.isFinite)||x1<0||x1>1||x2<0||x2>1||x1>x2||y1< -2||y1>2||y2< -2||y2>2)throw new Error("Bezier handles require 0 ≤ x1 ≤ x2 ≤ 1 and y values between -2 and 2.");
   next.bezier={x1:Number(x1),y1:Number(y1),x2:Number(x2),y2:Number(y2)};
  }
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
/** Copy a motion curve to another clip while preserving its shape and scaling clip-local timing. */
export function retimeMotionKeyframes(points:readonly MotionKeyframe[]|undefined,sourceDurationSeconds:number,targetDurationSeconds:number):MotionKeyframe[]{
 if(!Number.isFinite(sourceDurationSeconds)||sourceDurationSeconds<=0||!Number.isFinite(targetDurationSeconds)||targetDurationSeconds<=0)
  throw new Error("Source and target motion durations must be positive and finite.");
 const source=normalizeMotionKeyframes(points,sourceDurationSeconds);
 const ratio=targetDurationSeconds/sourceDurationSeconds;
 return normalizeMotionKeyframes(source.map(point=>({...point,timeSeconds:Number((point.timeSeconds*ratio).toFixed(4)),...(point.bezier?{bezier:{...point.bezier}}:{})})),targetDurationSeconds);
}
function cubicBezierCoordinate(t:number,a:number,b:number){const u=1-t;return 3*u*u*t*a+3*u*t*t*b+t*t*t;}
function easeMotionRatio(ratio:number,mode:MotionKeyframe["interpolation"],curve?:MotionKeyframe["bezier"]){
 const x=Math.max(0,Math.min(1,ratio));
 if(mode==="ease-in")return x*x*x;
 if(mode==="ease-out")return 1-Math.pow(1-x,3);
 if(mode==="ease-in-out")return x*x*(3-2*x);
 if(mode==="bezier"){
  const {x1,y1,x2,y2}=curve??{x1:0.25,y1:0.1,x2:0.25,y2:1};
  let low=0,high=1,t=x;
  for(let index=0;index<24;index++){const estimate=cubicBezierCoordinate(t,x1,x2);if(Math.abs(estimate-x)<1e-7)break;if(estimate<x)low=t;else high=t;t=(low+high)/2;}
  return cubicBezierCoordinate(t,y1,y2);
 }
 return x;
}
export function evaluateMotionProperty(points:readonly MotionKeyframe[]|undefined,timeSeconds:number,property:MotionProperty,fallback:number,durationSeconds:number):number{
 const keys=normalizeMotionKeyframes(points,durationSeconds).filter(point=>point[property]!==undefined),time=Math.max(0,Math.min(durationSeconds,Number.isFinite(timeSeconds)?timeSeconds:0));
 if(!keys.length)return fallback;
 let previousTime=0,previousValue=fallback;
 for(const point of keys){
  const value=point[property] as number;
  if(time<point.timeSeconds){
   if(point.interpolation==="step"||point.timeSeconds<=previousTime)return previousValue;
   const ratio=easeMotionRatio((time-previousTime)/(point.timeSeconds-previousTime),point.interpolation,point.bezier);
   return previousValue+(value-previousValue)*ratio;
  }
  previousTime=point.timeSeconds;previousValue=value;
 }
 return previousValue;
}
export function evaluateMotionKeyframes(points:readonly MotionKeyframe[]|undefined,timeSeconds:number,base:{x:number;y:number;width:number;height:number;opacity:number;rotation:number},durationSeconds:number,playbackMode:MotionPlaybackMode="none"){
 const keys=normalizeMotionKeyframes(points,durationSeconds),first=keys[0]?.timeSeconds??0,last=keys[keys.length-1]?.timeSeconds??0,span=last-first;let time=timeSeconds;
 if(span>0&&first===0&&Number.isFinite(time)&&time>=first){const elapsed=time-first;if(playbackMode==="loop")time=first+((elapsed%span)+span)%span;else if(playbackMode==="ping-pong"){const cycle=((elapsed%(span*2))+span*2)%(span*2);time=first+(cycle<=span?cycle:span*2-cycle);}}
 return {x:evaluateMotionProperty(points,time,"x",base.x,durationSeconds),y:evaluateMotionProperty(points,time,"y",base.y,durationSeconds),width:evaluateMotionProperty(points,time,"width",base.width,durationSeconds),height:evaluateMotionProperty(points,time,"height",base.height,durationSeconds),opacity:evaluateMotionProperty(points,time,"opacity",base.opacity,durationSeconds),rotation:evaluateMotionProperty(points,time,"rotation",base.rotation,durationSeconds)};
}
