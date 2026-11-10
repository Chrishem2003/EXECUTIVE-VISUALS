const clamp=(value,min,max)=>Math.max(min,Math.min(max,Number.isFinite(Number(value))?Number(value):0));

/**
 * Compile the editor's non-destructive clip effect layer into safe FFmpeg
 * filter fragments. Only bounded numeric values are accepted; no user text
 * is interpolated into a filter expression.
 */
export function buildTimelineClipEffects(metadata={}){
 const effects=metadata&&typeof metadata==="object"&&metadata.timelineEffects&&typeof metadata.timelineEffects==="object"?metadata.timelineEffects:{};
 const brightness=clamp(effects.brightness??0,-0.5,0.5);
 const contrast=clamp(effects.contrast??1,0.5,2);
 const saturation=clamp(effects.saturation??1,0,2);
 const denoise=clamp(effects.denoise??0,0,10);
 const sharpen=clamp(effects.sharpen??0,0,1);
 const preScale=[];
 const postScale=[];
 if(brightness!==0||contrast!==1||saturation!==1)preScale.push("eq=brightness="+brightness.toFixed(3)+":contrast="+contrast.toFixed(3)+":saturation="+saturation.toFixed(3));
 if(denoise>0)preScale.push("hqdn3d="+denoise.toFixed(2)+":"+denoise.toFixed(2)+":"+Math.max(0.5,denoise*4).toFixed(2)+":"+Math.max(0.5,denoise*4).toFixed(2));
 if(sharpen>0)postScale.push("unsharp=5:5:"+sharpen.toFixed(2)+":3:3:0");
 return Object.freeze({preScale:Object.freeze(preScale),postScale:Object.freeze(postScale),enabled:preScale.length+postScale.length>0});
}
