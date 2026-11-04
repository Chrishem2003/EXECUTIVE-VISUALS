import type { EditorialTimeline, TimelineClip, TimelineTrack } from "./timeline";

/** Convert a frame index to seconds without accumulating playback-time rounding. */
export function frameToSeconds(frame:number, frameRate:{numerator:number;denominator:number}):number {
  if(!Number.isSafeInteger(frame)||frame<0||!Number.isSafeInteger(frameRate.numerator)||!Number.isSafeInteger(frameRate.denominator)||frameRate.numerator<=0||frameRate.denominator<=0) {
    throw new Error("Frame and frame-rate values must be non-negative integers with a positive rational frame rate.");
  }
  return frame*frameRate.denominator/frameRate.numerator;
}

export function secondsToFrame(seconds:number, frameRate:{numerator:number;denominator:number}):number {
  if(!Number.isFinite(seconds)||seconds<0||!Number.isSafeInteger(frameRate.numerator)||!Number.isSafeInteger(frameRate.denominator)||frameRate.numerator<=0||frameRate.denominator<=0) {
    throw new Error("Time and frame rate must be finite and non-negative.");
  }
  return Math.max(0,Math.round(seconds*frameRate.numerator/frameRate.denominator));
}

export function clipSourceSecondsAtTimelineFrame(clip:TimelineClip,timelineFrame:number,timelineRate:{numerator:number;denominator:number}):number {
  if(!Number.isFinite(timelineFrame)||timelineFrame<0)throw new Error("Timeline frame must be non-negative.");
  const timelineFps=timelineRate.numerator/timelineRate.denominator;
  if(!Number.isFinite(timelineFps)||timelineFps<=0)throw new Error("Timeline frame rate must be positive.");
  const speed=clip.speed??1;
  if(!Number.isFinite(speed)||speed<=0)throw new Error("Clip speed must be positive.");
  const timelineStart=clip.timelineStart.value/clip.timelineStart.rate;
  const sourceStart=clip.sourceRange.start.value/clip.sourceRange.start.rate;
  const sourceDuration=clip.sourceRange.duration.value/clip.sourceRange.duration.rate;
  const elapsed=Math.max(0,timelineFrame/timelineFps-timelineStart)*speed;
  return Math.min(sourceStart+sourceDuration,sourceStart+elapsed);
}

export interface ActiveTimelineClip {
  track:TimelineTrack;
  clip:TimelineClip;
  timelineSeconds:number;
  sourceSeconds:number;
  sourceInSeconds:number;
  sourceOutSeconds:number;
}

/** Resolve every enabled clip covering a timeline frame, preserving track order for compositing. */
export function resolveTimelineFrame(timeline:EditorialTimeline,frame:number):ActiveTimelineClip[] {
  const timelineSeconds=frameToSeconds(frame,timeline.frameRate);
  const active:ActiveTimelineClip[]=[];
  for(const track of timeline.tracks) {
    if(!track.enabled)continue;
    for(const clip of track.clips) {
      if(!clip.enabled)continue;
      const start=clip.timelineStart.value/clip.timelineStart.rate;
      const duration=clip.duration.value/clip.duration.rate;
      if(!Number.isFinite(start)||!Number.isFinite(duration)||duration<=0)continue;
      if(timelineSeconds<start||timelineSeconds>=start+duration)continue;
      const sourceInSeconds=clip.sourceRange.start.value/clip.sourceRange.start.rate;
      const sourceDuration=clip.sourceRange.duration.value/clip.sourceRange.duration.rate;
      const sourceOutSeconds=sourceInSeconds+sourceDuration;
      const sourceSeconds=clampPreviewSeconds(
        clipSourceSecondsAtTimelineFrame(clip,frame,timeline.frameRate),
        sourceInSeconds,
        sourceOutSeconds
      );
      active.push({track,clip,timelineSeconds,sourceSeconds,sourceInSeconds,sourceOutSeconds});
    }
  }
  return active;
}

/** Return the sequence's duration in timeline frames, rounded up to include its final partial frame. */
export function getTimelineDurationFrames(timeline:EditorialTimeline):number {
  const rate=timeline.frameRate;
  if(!Number.isSafeInteger(rate.numerator)||!Number.isSafeInteger(rate.denominator)||rate.numerator<=0||rate.denominator<=0) {
    throw new Error("Timeline frame rate must be a positive rational value.");
  }
  const endSeconds=timeline.tracks.reduce((latest,track)=>{
    if(!track.enabled)return latest;
    return track.clips.reduce((trackLatest,clip)=>{
      if(!clip.enabled)return trackLatest;
      const end=clip.timelineStart.value/clip.timelineStart.rate+clip.duration.value/clip.duration.rate;
      return Number.isFinite(end)?Math.max(trackLatest,end):trackLatest;
    },latest);
  },0);
  return Math.max(0,Math.ceil(endSeconds*rate.numerator/rate.denominator));
}

export function clampPreviewSeconds(value:number,start:number,end:number):number {
  if(!Number.isFinite(value)||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start) {
    throw new Error("Preview bounds must be finite and ordered.");
  }
  return Math.min(end,Math.max(start,value));
}

export function stepPreviewSeconds(current:number,direction:-1|1,sourceFrameRate:number,start:number,end:number):number {
  if(!Number.isFinite(sourceFrameRate)||sourceFrameRate<=0)throw new Error("Source frame rate must be positive.");
  return clampPreviewSeconds(current+direction/sourceFrameRate,start,end);
}

/** Convert a clip's decibel gain to a linear amplitude multiplier. */
export function decibelsToLinearGain(decibels:number):number {
 if(!Number.isFinite(decibels))throw new Error("Clip gain must be finite.");
 const bounded=Math.max(-60,Math.min(24,decibels));
 return Math.pow(10,bounded/20);
}
