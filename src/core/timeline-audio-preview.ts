import type { EditorialTimeline } from "./timeline";
import { resolveTimelineFrame } from "./timeline-preview.ts";

export interface AudioPreviewClip {
  trackId:string;
  clipId:string;
  assetId:string;
  sourceSeconds:number;
  gainLinear:number;
  playbackRate:number;
}

/** Resolve every enabled audio clip at a timeline frame for synchronized browser mixing. */
export function resolveTimelineAudioFrame(timeline:EditorialTimeline,frame:number):AudioPreviewClip[] {
  return resolveTimelineFrame(timeline,frame).filter(item=>item.track.kind==="audio").map(item=>{
    const gainDb=Math.max(-60,Math.min(24,Number(item.clip.gainDb)||0));
    const speed=item.clip.speed??1;
    if(!Number.isFinite(speed)||speed<=0)throw new Error("Audio clip playback speed must be positive.");
    return {
      trackId:item.track.id,
      clipId:item.clip.id,
      assetId:item.clip.assetId,
      sourceSeconds:item.sourceSeconds,
      gainLinear:Math.max(0,Math.min(1,Math.pow(10,gainDb/20))),
      playbackRate:Math.max(0.25,Math.min(4,speed))
    };
  });
}
