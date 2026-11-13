import { evaluateSpeedCurve, sourceElapsedSeconds, type EditorialTimeline, type TimelineClip, type TimelineTrack } from "./timeline.ts";

export interface TimelinePlaybackItem {
  clipId: string;
  trackId: string;
  trackKind: TimelineTrack["kind"];
  trackIndex: number;
  assetId: string;
  timelineStartSeconds: number;
  timelineEndSeconds: number;
  mediaTimeSeconds: number;
  gainDb: number;
  speed: number;
  opacity: number;
}

export interface TimelinePlaybackFrame {
  playheadSeconds: number;
  durationSeconds: number;
  active: TimelinePlaybackItem[];
  activeVideo: TimelinePlaybackItem[];
  activeAudio: TimelinePlaybackItem[];
  activeImages: TimelinePlaybackItem[];
}

const positive = (value: number, fallback: number) =>
  Number.isFinite(value) && value > 0 ? value : fallback;

export function timelineDurationSeconds(timeline: EditorialTimeline): number {
  return Math.max(0, ...timeline.tracks.flatMap(track =>
    track.clips.map(clip => clip.timelineStart.value / clip.timelineStart.rate + clip.duration.value / clip.duration.rate)
  ));
}

export function frameToTimelineSeconds(frame: number, timeline: EditorialTimeline): number {
  const rate = positive(timeline.frameRate.numerator / timeline.frameRate.denominator, 24);
  return Math.max(0, Math.round(Number.isFinite(frame) ? frame : 0)) / rate;
}

export function timelineSecondsToFrame(seconds: number, timeline: EditorialTimeline): number {
  const rate = positive(timeline.frameRate.numerator / timeline.frameRate.denominator, 24);
  return Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * rate));
}

export function clampTimelineFrame(frame: number, timeline: EditorialTimeline): number {
  return Math.min(timelineSecondsToFrame(timelineDurationSeconds(timeline), timeline), Math.max(0, Math.round(Number.isFinite(frame) ? frame : 0)));
}

export function timelineClipMediaTimeSeconds(clip: TimelineClip, timelineSeconds: number): number {
  const start = clip.timelineStart.value / clip.timelineStart.rate;
  const sourceStart = clip.sourceRange.start.value / clip.sourceRange.start.rate;
  const sourceDuration = clip.sourceRange.duration.value / clip.sourceRange.duration.rate;
  const elapsed = Math.max(0, timelineSeconds - start);
  const mediaOffset = Math.min(sourceDuration, sourceElapsedSeconds(clip, elapsed));
  return sourceStart + mediaOffset;
}

export function getTimelinePlaybackFrame(timeline: EditorialTimeline, playheadSeconds: number): TimelinePlaybackFrame {
  const durationSeconds = timelineDurationSeconds(timeline);
  const safeTime = Math.min(durationSeconds, Math.max(0, Number.isFinite(playheadSeconds) ? playheadSeconds : 0));
  const active: TimelinePlaybackItem[] = [];

  timeline.tracks.forEach((track, trackIndex) => {
    if (!track.enabled || track.kind === "caption") return;
    const enabledVideoClips=track.kind==="video"?track.clips.filter(item=>item.enabled).slice().sort((a,b)=>a.timelineStart.value/a.timelineStart.rate-b.timelineStart.value/b.timelineStart.rate):[];
    for (const clip of track.clips) {
      if (!clip.enabled) continue;
      const start = clip.timelineStart.value / clip.timelineStart.rate;
      const end = start + clip.duration.value / clip.duration.rate;
      if (safeTime < start || safeTime >= end) continue;
      let opacity=1;
      if(track.kind==="video"){
        const index=enabledVideoClips.findIndex(item=>item.id===clip.id),previous=enabledVideoClips[index-1];
        const fadeIn=previous?.transitionToNext?.type==="dip-to-black"?previous.transitionToNext.fadeFrames/(timeline.frameRate.numerator/timeline.frameRate.denominator):0;
        const fadeOut=clip.transitionToNext?.type==="dip-to-black"?clip.transitionToNext.fadeFrames/(timeline.frameRate.numerator/timeline.frameRate.denominator):0;
        if(fadeIn>0)opacity=Math.min(opacity,Math.max(0,Math.min(1,(safeTime-start)/fadeIn)));
        if(fadeOut>0)opacity=Math.min(opacity,Math.max(0,Math.min(1,(end-safeTime)/fadeOut)));
      }
      active.push({
        clipId: clip.id,
        trackId: track.id,
        trackKind: track.kind,
        trackIndex,
        assetId: clip.assetId,
        timelineStartSeconds: start,
        timelineEndSeconds: end,
        mediaTimeSeconds: timelineClipMediaTimeSeconds(clip, safeTime),
        gainDb: Math.max(-60, Math.min(24, Number.isFinite(clip.gainDb) ? clip.gainDb! : 0)),
        speed: evaluateSpeedCurve(clip.speedCurve, safeTime-start, positive(clip.speed ?? 1, 1)),
        opacity,
      });
    }
  });

  active.sort((a, b) => a.trackIndex - b.trackIndex || a.timelineStartSeconds - b.timelineStartSeconds);
  return {
    playheadSeconds: safeTime,
    durationSeconds,
    active,
    activeVideo: active.filter(item => item.trackKind === "video"),
    activeAudio: active.filter(item => item.trackKind === "audio"),
    activeImages: active.filter(item => item.trackKind === "overlay"),
  };
}

export type TimelineClipPreviewEffectValues={brightness:number;contrast:number;saturation:number;intercept:number};

/** Keep preview color controls numerically aligned with FFmpeg's eq filter. */
export function timelineClipPreviewEffectValues(clip:Pick<TimelineClip,"metadata">):TimelineClipPreviewEffectValues {
  const effects=(clip.metadata?.timelineEffects&&typeof clip.metadata.timelineEffects==="object"?clip.metadata.timelineEffects:{}) as Record<string,unknown>;
  const bounded=(value:unknown,fallback:number,min:number,max:number)=>{
    const parsed=Number(value);
    return Math.max(min,Math.min(max,Number.isFinite(parsed)?parsed:fallback));
  };
  const brightness=bounded(effects.brightness,0,-0.5,0.5);
  const contrast=bounded(effects.contrast,1,0.5,2);
  const saturation=bounded(effects.saturation,1,0,2);
  return {brightness,contrast,saturation,intercept:0.5*(1-contrast)+brightness};
}

/** The SVG filter uses linear component transfer followed by saturation, matching FFmpeg eq semantics. */
export function timelineClipPreviewFilter(clip:Pick<TimelineClip,"metadata">):string {
  const {brightness,contrast,saturation}=timelineClipPreviewEffectValues(clip);
  return brightness===0&&contrast===1&&saturation===1?"none":"url(#ev-timeline-clip-effects)";
}


export interface TimelinePreviewAssetRef {
  id:string;
  mediaType:string;
  derivativeOf?:string|null;
}

/** Prefer a source-linked video proxy only when it is present in the caller's authorized asset set. */
export function selectTimelinePreviewAsset<T extends TimelinePreviewAssetRef>(
  clip:Pick<TimelineClip,"metadata">,
  source:T,
  authorizedAssets:readonly T[],
):T {
  const proxyId=typeof clip.metadata?.proxyAssetId==="string"?clip.metadata.proxyAssetId:"";
  if(!proxyId)return source;
  const proxy=authorizedAssets.find(asset=>asset.id===proxyId&&asset.mediaType.startsWith("video/")&&asset.derivativeOf===source.id);
  return proxy||source;
}

/** Signed preview URLs must be renewed before their storage token expires. */
export function isTimelinePreviewUrlFresh(expiresAtMs:number,nowMs=Date.now(),minimumValidityMs=30_000):boolean {
  return Number.isFinite(expiresAtMs)&&Number.isFinite(nowMs)&&Number.isFinite(minimumValidityMs)&&
    minimumValidityMs>=0&&expiresAtMs>nowMs+minimumValidityMs;
}

/** Allow one authenticated signed-URL renewal per cloud asset during a preview session. */
export function shouldRetryTimelinePreviewUrl(
  mode:"local"|"cloud",assetId:string,attemptedAssetIds:readonly string[],
):boolean {
  return mode==="cloud"&&assetId.length>0&&!attemptedAssetIds.includes(assetId);
}

/** A failed derivative may fall back only to its own canonical source, once per preview session. */
export function shouldFallbackToTimelineSourcePreview(
  isProxy:boolean,sourceAssetId:string,proxyAssetId:string,unavailableProxyAssetIds:readonly string[],
):boolean {
  return isProxy&&sourceAssetId.length>0&&proxyAssetId.length>0&&
    sourceAssetId!==proxyAssetId&&!unavailableProxyAssetIds.includes(proxyAssetId);
}
