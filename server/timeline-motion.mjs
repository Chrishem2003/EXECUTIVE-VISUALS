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
 for(const point of keys){const value=point[property];if(time<point.timeSeconds){if(point.interpolation==="step"||point.timeSeconds<=previousTime)return previousValue;const raw=(time-previousTime)/(point.timeSeconds-previousTime),t=Math.max(0,Math.min(1,raw)),ratio=point.interpolation==="ease-in"?t*t*t:point.interpolation==="ease-out"?1-Math.pow(1-t,3):point.interpolation==="ease-in-out"?t*t*(3-2*t):t;return previousValue+(value-previousValue)*ratio;}previousTime=point.timeSeconds;previousValue=value;}
 return previousValue;
}
function number(value){return Number(value.toFixed(6)).toString();}
export function buildTimelineMotionExpression(points,property,fallback,durationSeconds,timeVariable="t"){
 const keys=normalizeTimelineMotion(points,durationSeconds).filter(point=>point[property]!==undefined);
 if(!keys.length)return number(fallback);
 const ratio=(mode,raw,time)=>{const u="clip("+raw+"\\,0\\,1)";if(mode==="step")return "gte("+timeVariable+"\\,"+number(time)+")";if(mode==="ease-in")return "("+u+")*("+u+")*("+u+")";if(mode==="ease-out")return "1-(1-("+u+"))*(1-("+u+"))*(1-("+u+"))";if(mode==="ease-in-out")return "("+u+")*("+u+")*(3-2*("+u+"))";return u;};
 const first=keys[0];
 let expression=number(first[property]);
 if(first.timeSeconds>0){const raw=timeVariable+"/"+number(first.timeSeconds);expression=number(fallback)+"+("+number(first[property]-fallback)+")*("+ratio(first.interpolation,raw,first.timeSeconds)+")";}
 for(let i=1;i<keys.length;i++){const left=keys[i-1],right=keys[i],raw="("+timeVariable+"-"+number(left.timeSeconds)+")/"+number(right.timeSeconds-left.timeSeconds);expression+="+("+number(right[property]-left[property])+")*("+ratio(right.interpolation,raw,right.timeSeconds)+")";}
 return expression;
}
export function buildTimelineMotionFilters(metadata={},durationSeconds,canvasWidth=1920,canvasHeight=1080){
 const width=Math.max(256,Math.min(7680,Math.floor(Number(canvasWidth)||1920))),height=Math.max(144,Math.min(4320,Math.floor(Number(canvasHeight)||1080)));
 const points=normalizeTimelineMotion(metadata.motionKeyframes,durationSeconds);
 const base={x:Math.max(-16384,Math.min(16384,Number(metadata.x)||0)),y:Math.max(-16384,Math.min(16384,Number(metadata.y)||0)),width:Math.max(16,Math.min(16384,Number(metadata.width)||width)),height:Math.max(16,Math.min(16384,Number(metadata.height)||height)),opacity:Math.max(0,Math.min(1,Number(metadata.opacity??1))),rotation:Math.max(-3600,Math.min(3600,Number(metadata.rotation)||0))};
 if(!points.length&&base.x===0&&base.y===0&&base.width===width&&base.height===height&&base.opacity===1&&base.rotation===0&&metadata.x===undefined&&metadata.y===undefined&&metadata.width===undefined&&metadata.height===undefined&&metadata.opacity===undefined&&metadata.rotation===undefined)return null;
 const animated=Object.fromEntries(Object.keys(LIMITS).map(property=>[property,points.some(point=>point[property]!==undefined)]));
 const expression=(property,variable="t")=>buildTimelineMotionExpression(points,property,base[property],durationSeconds,variable);
 const widthExpression=animated.width?expression("width"):""+number(base.width),heightExpression=animated.height?expression("height"):""+number(base.height),x=animated.x?expression("x"):""+number(base.x),y=animated.y?expression("y"):""+number(base.y);
 const opacity=animated.opacity?expression("opacity","T"):""+number(base.opacity),rotated=animated.rotation||base.rotation!==0;
 const maxWidth=Math.max(base.width,...points.map(point=>point.width??base.width)),maxHeight=Math.max(base.height,...points.map(point=>point.height??base.height));
 const rotationCanvas=rotated?Math.min(16384,Math.ceil(Math.hypot(maxWidth,maxHeight))):0;
 const alpha=animated.opacity?"geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*("+opacity+")'":"colorchannelmixer=aa="+number(base.opacity);
 const filters=[];
 if(rotated){
  const rotatedWidth="("+rotationCanvas+")*("+widthExpression+")/"+number(maxWidth),rotatedHeight="("+rotationCanvas+")*("+heightExpression+")/"+number(maxHeight);
  filters.push("scale="+Math.round(maxWidth)+":"+Math.round(maxHeight)+":force_original_aspect_ratio=decrease","format=rgba","pad="+Math.round(maxWidth)+":"+Math.round(maxHeight)+":(ow-iw)/2:(oh-ih)/2:color=black@0",alpha,"rotate=angle='("+expression("rotation")+")*PI/180':ow="+rotationCanvas+":oh="+rotationCanvas+":c=none","scale=w='"+rotatedWidth+"':h='"+rotatedHeight+"':eval=frame");
  const overlayX="("+x+")+(("+widthExpression+")-("+rotatedWidth+"))/2",overlayY="("+y+")+(("+heightExpression+")-("+rotatedHeight+"))/2";
  return {filters,overlay:"overlay=x='"+overlayX+"':y='"+overlayY+"':eval=frame:eof_action=pass",animated};
 }
 const scale=animated.width||animated.height?"scale=w='"+widthExpression+"':h='"+heightExpression+"':eval=frame:force_original_aspect_ratio=decrease":"scale="+Math.round(base.width)+":"+Math.round(base.height)+":force_original_aspect_ratio=decrease";
 filters.push("format=rgba",alpha,scale);
 return {filters,overlay:"overlay=x='"+x+"':y='"+y+"':eval=frame:eof_action=pass",animated};
}
