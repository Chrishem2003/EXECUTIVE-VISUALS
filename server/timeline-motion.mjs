const LIMITS=Object.freeze({x:[-16384,16384],y:[-16384,16384],width:[16,16384],height:[16,16384],opacity:[0,1],rotation:[-3600,3600]});
export function normalizeTimelineMotion(points,durationSeconds){
 if(points===undefined)return [];
 if(!Array.isArray(points)||points.length>256)throw Object.assign(new Error("Motion animation supports at most 256 keyframes per clip."),{code:"INVALID_MOTION_KEYFRAMES"});
 if(!Number.isFinite(durationSeconds)||durationSeconds<=0)throw Object.assign(new Error("Motion clip duration must be positive and finite."),{code:"INVALID_MOTION_KEYFRAMES"});
 const sorted=points.map(point=>{
  if(!point||!Number.isFinite(point.timeSeconds)||point.timeSeconds<0||point.timeSeconds>durationSeconds)throw Object.assign(new Error("Motion keyframe time must stay inside its clip."),{code:"INVALID_MOTION_KEYFRAMES"});
  const next={timeSeconds:Number(point.timeSeconds),interpolation:["step","ease-in","ease-out","ease-in-out"].includes(point.interpolation)?point.interpolation:"linear"};let count=0;
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
 for(const point of keys){const value=point[property];if(time<point.timeSeconds){if(point.interpolation==="step"||point.timeSeconds<=previousTime)return previousValue;const raw=(time-previousTime)/(point.timeSeconds-previousTime),t=Math.max(0,Math.min(1,raw)),ratio=point.interpolation==="ease-in"?t*t*t:point.interpolation==="ease-out"?1-Math.pow(1-t,3):point.interpolation==="ease-in-out"?(t<0.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2):t;return previousValue+(value-previousValue)*ratio;}previousTime=point.timeSeconds;previousValue=value;}
 return previousValue;
}
function number(value){return Number(value.toFixed(6)).toString();}
export function buildTimelineMotionExpression(points,property,fallback,durationSeconds,timeVariable="t"){
 const keys=normalizeTimelineMotion(points,durationSeconds).filter(point=>point[property]!==undefined);
 if(!keys.length)return number(fallback);
 let expression=number(keys[keys.length-1][property]);
 for(let i=keys.length-1;i>=1;i--){
  const left=keys[i-1],right=keys[i],start=left.timeSeconds,end=right.timeSeconds,from=left[property],to=right[property];
  const r="("+timeVariable+"-"+number(start)+")/"+number(end-start),eased=right.interpolation==="step"?"0":right.interpolation==="ease-in"?"pow("+r+"\\,3)":right.interpolation==="ease-out"?"1-pow(1-"+r+"\\,3)":right.interpolation==="ease-in-out"?"if(lt("+r+"\\,0.5)\\,4*pow("+r+"\\,3)\\,1-pow(-2*"+r+"+2\\,3)/2)":r;const value=right.interpolation==="step"?number(from):number(from)+"+("+number(to-from)+")*("+eased+")";
  expression="if(lt("+timeVariable+"\\,"+number(end)+")\\,"+value+"\\,"+expression+")";
 }
 const first=keys[0];
 if(first.timeSeconds>0){const r="("+timeVariable+")/"+number(first.timeSeconds),eased=first.interpolation==="step"?"0":first.interpolation==="ease-in"?"pow("+r+"\\,3)":first.interpolation==="ease-out"?"1-pow(1-"+r+"\\,3)":first.interpolation==="ease-in-out"?"if(lt("+r+"\\,0.5)\\,4*pow("+r+"\\,3)\\,1-pow(-2*"+r+"+2\\,3)/2)":r;const value=first.interpolation==="step"?number(fallback):number(fallback)+"+("+number(first[property]-fallback)+")*("+eased+")";expression="if(lt("+timeVariable+"\\,"+number(first.timeSeconds)+")\\,"+value+"\\,"+expression+")";}
 else expression="if(lt("+timeVariable+"\\,0)\\,"+number(first[property])+"\\,"+expression+")";
 return expression;
}
export function buildTimelineMotionFilters(metadata={},durationSeconds){
 const points=normalizeTimelineMotion(metadata.motionKeyframes,durationSeconds);
 const base={x:Number(metadata.x)||0,y:Number(metadata.y)||0,width:Math.max(16,Number(metadata.width)||16),height:Math.max(16,Number(metadata.height)||16),opacity:Math.max(0,Math.min(1,Number(metadata.opacity??1))),rotation:Math.max(-3600,Math.min(3600,Number(metadata.rotation)||0))};
 if(!points.length&&base.rotation===0&&base.x===0&&base.y===0&&base.opacity===1&&metadata.width===undefined&&metadata.height===undefined)return null;
 const animated=Object.fromEntries(Object.keys(LIMITS).map(property=>[property,points.some(point=>point[property]!==undefined)]));
 const expression=(property,variable="t")=>buildTimelineMotionExpression(points,property,base[property],durationSeconds,variable);
 const scale=animated.width||animated.height?"scale=w='"+expression("width")+"':h='"+expression("height")+"':eval=frame": "scale="+Math.round(base.width)+":"+Math.round(base.height);
 const rotated=animated.rotation||base.rotation!==0;
 const maxWidth=Math.max(base.width,...points.map(point=>point.width??base.width)),maxHeight=Math.max(base.height,...points.map(point=>point.height??base.height));
 const rotationCanvas=rotated?Math.ceil(Math.hypot(maxWidth,maxHeight)):0;
 const rotate=rotated?"rotate=angle='("+expression("rotation")+")*PI/180':ow=iw:oh=ih:c=none":null;
 const alpha=animated.opacity?"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*("+expression("opacity","T")+")'": "colorchannelmixer=aa="+number(base.opacity);
 const widthExpression=animated.width?expression("width"):""+number(base.width),heightExpression=animated.height?expression("height"):""+number(base.height),x=animated.x?expression("x"):""+number(base.x),y=animated.y?expression("y"):""+number(base.y),overlayX=rotated?"("+x+")+(("+widthExpression+")-"+rotationCanvas+")/2":x,overlayY=rotated?"("+y+")+(("+heightExpression+")-"+rotationCanvas+")/2":y;
 const finalFilters=rotated?[scale,"format=rgba","pad="+rotationCanvas+":"+rotationCanvas+":(ow-iw)/2:(oh-ih)/2:color=black@0",rotate,alpha]:[scale,"format=rgba",alpha];
 return {filters:finalFilters,overlay:"overlay=x='max(0,min(main_w-overlay_w,"+overlayX+"))':y='max(0,min(main_h-overlay_h,"+overlayY+"))':eval=frame:eof_action=pass",animated};
}
