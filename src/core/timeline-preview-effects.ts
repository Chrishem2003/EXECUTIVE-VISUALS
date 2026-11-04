import type { TimelineClip } from "./timeline";

export interface TimelineClipPreviewStyle {
  filter:string;
  opacity:number;
}

/** Calculate the browser's visual approximation for the supported color and fade descriptors. */
export function getTimelineClipPreviewStyle(clip:TimelineClip,timelineSeconds:number,frameRate:{numerator:number;denominator:number}):TimelineClipPreviewStyle {
  const effects=(clip.effects||[]).filter(effect=>effect.enabled!==false&&effect.type==="color");
  let brightness=1,contrast=1,saturation=1;
  for(const effect of effects){
    brightness*=effect.parameters.brightness;
    contrast*=effect.parameters.contrast;
    saturation*=effect.parameters.saturation;
  }
  const filter=effects.length?[
    "brightness("+Math.max(0,Math.min(4,brightness)).toFixed(4)+")",
    "contrast("+Math.max(0,Math.min(4,contrast)).toFixed(4)+")",
    "saturate("+Math.max(0,Math.min(6,saturation)).toFixed(4)+")"
  ].join(" "):"";
  const fps=frameRate.numerator/frameRate.denominator,start=clip.timelineStart.value/clip.timelineStart.rate,duration=clip.duration.value/clip.duration.rate;
  const elapsedFrames=Math.max(0,(timelineSeconds-start)*fps),clipFrames=duration*fps;
  let opacity=1;
  if(clip.transitionIn)opacity=Math.min(opacity,Math.max(0,Math.min(1,elapsedFrames/clip.transitionIn.durationFrames)));
  if(clip.transitionOut)opacity=Math.min(opacity,Math.max(0,Math.min(1,(clipFrames-elapsedFrames)/clip.transitionOut.durationFrames)));
  return{filter,opacity};
}
