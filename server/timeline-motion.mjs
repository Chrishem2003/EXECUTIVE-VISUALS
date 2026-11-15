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
export function buildTimelineMotionFilters(metadata={},durationSeconds,canvasWidth=1920,canvasHeight=1080){
 const width=Math.max(256,Math.min(7680,Math.floor(Number(canvasWidth)||1920))),height=Math.max(144,Math.min(4320,Math.floor(Number(canvasHeight)||1080)));
 const points=normalizeTimelineMotion(metadata.motionKeyframes,durationSeconds);
 const base={x:Math.max(-16384,Math.min(16384,Number(metadata.x)||0)),y:Math.max(-16384,Math.min(16384,Number(metadata.y)||0)),width:Math.max(16,Math.min(16384,Number(metadata.width)||width)),height:Math.max(16,Math.min(16384,Number(metadata.height)||height)),opacity:Math.max(0,Math.min(1,Number(metadata.opacity??1))),rotation:Math.max(-3600,Math.min(3600,Number(metadata.rotation)||0))};
 if(!points.length&&base.x===0&&base.y===0&&base.width===width&&base.height===height&&base.opacity===1&&base.rotation===0&&metadata.x===undefined&&metadata.y===undefined&&metadata.width===undefined&&metadata.height===undefined&&metadata.opacity===undefined&&metadata.rotation===undefined)return null;
 const animated=Object.fromEntries(Object.keys(LIMITS).map(property=>[property,points.some(point=>point[property]!==undefined)]));
 const expression=(property)=>buildTimelineMotionExpression(points,property,base[property],durationSeconds,"T");
 const x=expression("x"),y=expression("y"),w=expression("width"),h=expression("height"),opacity=expression("opacity"),angle="("+expression("rotation")+")*PI/180";
 const dx="(X-(("+x+")+("+w+")/2))",dy="(Y-(("+y+")+("+h+")/2))";
 const localX="(("+dx+")*cos("+angle+")+("+dy+")*sin("+angle+"))",localY="(-("+dx+")*sin("+angle+")+("+dy+")*cos("+angle+"))";
 const sourceX="((("+localX+")/("+w+")+0.5)*"+width+")",sourceY="((("+localY+")/("+h+")+0.5)*"+height+")";
 const inside="lt(abs("+localX+")\\,("+w+")/2)*lt(abs("+localY+")\\,("+h+")/2)";
 const sample=channel=>"if("+inside+"\\,"+channel+"("+sourceX+"\\,"+sourceY+")\\,0)";
 const alpha="if("+inside+"\\,alpha("+sourceX+"\\,"+sourceY+")*("+opacity+")\\,0)";
 const graph="geq=r='"+sample("r")+"':g='"+sample("g")+"':b='"+sample("b")+"':a='"+alpha+"'";
 const filters=["scale="+width+":"+height+":force_original_aspect_ratio=decrease","pad="+width+":"+height+":(ow-iw)/2:(oh-ih)/2:color=black@0","format=rgba",graph];
 return {filters,overlay:"overlay=0:0:eof_action=pass",animated};
}
