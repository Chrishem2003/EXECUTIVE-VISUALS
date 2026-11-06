const finite=(value,fallback)=>Number.isFinite(Number(value))?Number(value):fallback;
export function normalizeOverlayKeyframes(value,{durationFrames=1,width=1920,height=1080,defaultX=0,defaultY=0}={}){
 const frames=Array.isArray(value)?value:[];
 if(frames.length>50)throw Object.assign(new Error("An overlay supports at most 50 motion keyframes."),{code:"INVALID_MOTION_KEYFRAMES"});
 const normalized=frames.map((item,index)=>{
  if(!item||typeof item!=="object"||Array.isArray(item))throw Object.assign(new Error("Motion keyframe "+(index+1)+" is invalid."),{code:"INVALID_MOTION_KEYFRAMES"});
  const frame=Number(item.frame),x=Number(item.x),y=Number(item.y),scale=finite(item.scale,1);
  if(!Number.isSafeInteger(frame)||frame<0||frame>durationFrames||!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>width||y<0||y>height||scale<0.1||scale>4)throw Object.assign(new Error("Motion keyframes require an in-range frame, bounded X/Y positions and scale from 0.1 to 4."),{code:"INVALID_MOTION_KEYFRAMES"});
  return{frame,x:Math.round(x),y:Math.round(y),scale:Number(scale.toFixed(4))};
 }).sort((a,b)=>a.frame-b.frame);
 for(let i=1;i<normalized.length;i++)if(normalized[i].frame===normalized[i-1].frame)throw Object.assign(new Error("Motion keyframe frames must be unique."),{code:"INVALID_MOTION_KEYFRAMES"});
 return normalized;
}
export function buildMotionExpression(keyframes,property,{startSeconds=0,fps=24,fallback=0}={}){
 const points=Array.isArray(keyframes)?keyframes:[];
 if(!points.length)return String(fallback);
 const value=point=>Number(point[property]);
 if(points.length===1)return String(value(points[0]));
 const time=point=>(startSeconds+point.frame/fps).toFixed(6);
 const lerp=(a,b)=>"("+value(a).toFixed(4)+"+("+value(b).toFixed(4)+"-"+value(a).toFixed(4)+")*(t-"+time(a)+")/("+time(b)+"-"+time(a)+"))";
 let expression=String(value(points[points.length-1]));
 for(let index=points.length-2;index>=0;index--){
  const a=points[index],b=points[index+1];
  expression="if(lt(t\\,"+time(b)+")\\,"+lerp(a,b)+"\\,"+expression+")";
 }
 return expression;
}
