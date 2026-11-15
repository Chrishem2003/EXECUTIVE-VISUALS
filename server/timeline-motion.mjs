const LIMITS=Object.freeze({x:[-16384,16384],y:[-16384,16384],width:[16,16384],height:[16,16384],opacity:[0,1],rotation:[-3600,3600]});
export function normalizeTimelineMotion(points,durationSeconds){
 if(points===undefined)return [];
 if(!Array.isArray(points)||points.length>256)throw Object.assign(new Error("Motion animation supports at most 256 keyframes per clip."),{code:"INVALID_MOTION_KEYFRAMES"});
 if(!Number.isFinite(durationSeconds)||durationSeconds<=0)throw Object.assign(new Error("Motion clip duration must be positive and finite."),{code:"INVALID_MOTION_KEYFRAMES"});
 const sorted=points.map(point=>{
  if(!point||!Number.isFinite(point.timeSeconds)||point.timeSeconds<0||point.timeSeconds>durationSeconds)throw Object.assign(new Error("Motion keyframe time must stay inside its clip."),{code:"INVALID_MOTION_KEYFRAMES"});
  const next={timeSeconds:Number(point.timeSeconds),interpolation:point.interpolation==="step"?"step":"linear"};let count=0;
  for(const [property,[min,max]] of Object.entries(LIMITS)){if(point[property]===undefined)continue;if(!Number.isFinite(point[property]))throw Object.assign(new Error("Motion keyframe values must be finite."),{code:"INVALID_MOTION_KEYFRAMES"});next[property]=Math.max(min,Math.min(max,Number(point[property])));count++;}
  if(!count)throw Object.assign(new Error("Motion keyframe must define at least one animated property."),{code:"INVALID_MOTION_KEYFRAMES"});
  return next;
 }).sort((a,b)=>a.timeSeconds-b.timeSeconds);
 for(let i=1;i<sorted.length;i++)if(sorted[i].timeSeconds===sorted[i-1].timeSeconds)throw Object.assign(new Error("Motion keyframe times must be unique."),{code:"INVALID_MOTION_KEYFRAMES"});
 return sorted;
}
export function evaluateTimelineMotion(points,timeSeconds,property,fallback,durationSeconds){
 const keys=normalizeTimelineMotion(points,durationSeconds).filter(point=>point[property]!==undefined),time=Math.max(0,Math.min(durationSeconds,Number.isFinite(timeSeconds)?timeSeconds:0));
 if(!keys.length)return fallback;let previousTime=0,previousValue=fallback;
 for(const point of keys){const value=point[property];if(time<point.timeSeconds){if(point.interpolation==="step"||point.timeSeconds<=previousTime)return previousValue;const ratio=(time-previousTime)/(point.timeSeconds-previousTime);return previousValue+(value-previousValue)*Math.max(0,Math.min(1,ratio));}previousTime=point.timeSeconds;previousValue=value;}
 return previousValue;
}
function number(value){return Number(value.toFixed(6)).toString();}
export function buildTimelineMotionExpression(points,property,fallback,durationSeconds,timeVariable="t"){
 const keys=normalizeTimelineMotion(points,durationSeconds).filter(point=>point[property]!==undefined);
 if(!keys.length)return number(fallback);
 let expression=number(keys[keys.length-1][property]);
 for(let i=keys.length-1;i>=1;i--){
  const left=keys[i-1],right=keys[i],start=left.timeSeconds,end=right.timeSeconds,from=left[property],to=right[property];
  const value=right.interpolation==="step"?number(from):number(from)+"+("+timeVariable+"-"+number(start)+")*("+number((to-from)/(end-start))+")";
  expression="if(lt("+timeVariable+"\\,"+number(end)+")\\,"+value+"\\,"+expression+")";
 }
 const first=keys[0];
 if(first.timeSeconds>0)expression="if(lt("+timeVariable+"\\,"+number(first.timeSeconds)+")\\,"+number(first[property])+"\\,"+expression+")";
 else expression="if(lt("+timeVariable+"\\,0)\\,"+number(first[property])+"\\,"+expression+")";
 return expression;
}
export function buildTimelineMotionFilters(metadata={},durationSeconds){
 const points=normalizeTimelineMotion(metadata.motionKeyframes,durationSeconds);
 if(!points.length)return null;
 const base={x:Number(metadata.x)||0,y:Number(metadata.y)||0,width:Math.max(16,Number(metadata.width)||16),height:Math.max(16,Number(metadata.height)||16),opacity:Math.max(0,Math.min(1,Number(metadata.opacity??1))),rotation:Math.max(-3600,Math.min(3600,Number(metadata.rotation)||0))};
 const animated=Object.fromEntries(Object.keys(LIMITS).map(property=>[property,points.some(point=>point[property]!==undefined)]));
 const expression=(property,variable="t")=>buildTimelineMotionExpression(points,property,base[property],durationSeconds,variable);
 const scale=animated.width||animated.height?"scale=w='"+expression("width")+"':h='"+expression("height")+"':eval=frame": "scale="+Math.round(base.width)+":"+Math.round(base.height);
 const rotate=animated.rotation?"rotate=angle='("+expression("rotation")+")*PI/180':ow=rotw(iw):oh=roth(ih):c=none":(base.rotation?"rotate=angle="+number(base.rotation*Math.PI/180)+":ow=rotw(iw):oh=roth(ih):c=none":null);
 const alpha=animated.opacity?"geq=a='alpha(X,Y)*("+expression("opacity","T")+")'": "colorchannelmixer=aa="+number(base.opacity);
 const x=animated.x?expression("x"):""+number(base.x),y=animated.y?expression("y"):""+number(base.y);
 return {filters:[scale,"format=rgba",...(rotate?[rotate]:[]),alpha],overlay:"overlay=x='max(0,min(main_w-overlay_w,"+x+"))':y='max(0,min(main_h-overlay_h,"+y+"))':eval=frame:eof_action=pass",animated};
}
