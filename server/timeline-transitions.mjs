/**
 * Build bounded clip-edge fades for FFmpeg. Durations are seconds and are
 * clamped to the actual clip so untrusted metadata cannot create invalid
 * negative or out-of-range filter timestamps.
 */
export function buildClipFadeFilters(clip,duration,kind="video"){
 const length=Number(duration);
 if(!Number.isFinite(length)||length<=0)return [];
 const metadata=clip?.metadata&&typeof clip.metadata==="object"?clip.metadata:{};
 const read=(key)=>{const value=Number(metadata[key]);return Number.isFinite(value)?Math.max(0,Math.min(length,value)):0;};
 const fadeIn=read("fadeInSeconds"),fadeOut=read("fadeOutSeconds"),filters=[];
 if(kind==="video"){
  if(fadeIn>0)filters.push("fade=t=in:st=0:d="+fadeIn.toFixed(6));
  if(fadeOut>0)filters.push("fade=t=out:st="+Math.max(0,length-fadeOut).toFixed(6)+":d="+fadeOut.toFixed(6));
 }else if(kind==="audio"){
  if(fadeIn>0)filters.push("afade=t=in:st=0:d="+fadeIn.toFixed(6));
  if(fadeOut>0)filters.push("afade=t=out:st="+Math.max(0,length-fadeOut).toFixed(6)+":d="+fadeOut.toFixed(6));
 }else throw new Error("Unsupported clip fade media kind.");
 return filters;
}
