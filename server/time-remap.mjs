/** Shared, bounded time-remapping primitives for local and cloud FFmpeg renders. */
export function normalizeClipSpeed(value=1){
 const speed=Number(value);
 if(!Number.isFinite(speed)||speed<0.25||speed>4)throw Object.assign(new Error("Clip speed must be between 0.25× and 4×."),{code:"INVALID_CLIP_SPEED"});
 return speed;
}
export function sourceDurationForTimeline(timelineDuration,speed=1){
 const duration=Number(timelineDuration),rate=normalizeClipSpeed(speed);
 if(!Number.isFinite(duration)||duration<=0)throw Object.assign(new Error("Timeline clip duration must be positive."),{code:"INVALID_CLIP_DURATION"});
 return duration*rate;
}
/** FFmpeg atempo supports 0.5–2 per stage; chain stages to cover 0.25×–4×. */
export function buildAtempoFilter(speed=1){
 let remaining=normalizeClipSpeed(speed);
 if(Math.abs(remaining-1)<1e-9)return "";
 const stages=[];
 while(remaining>2+1e-9){stages.push(2);remaining/=2;}
 while(remaining<0.5-1e-9){stages.push(0.5);remaining/=0.5;}
 if(Math.abs(remaining-1)>1e-9)stages.push(remaining);
 return stages.map(value=>"atempo="+Number(value.toFixed(6))).join(",");
}
