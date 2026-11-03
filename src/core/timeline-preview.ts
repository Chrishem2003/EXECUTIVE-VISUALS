import type { TimelineClip } from "./timeline";

/** Convert a frame index to seconds without accumulating playback-time rounding. */
export function frameToSeconds(frame:number, frameRate:{numerator:number;denominator:number}):number {
  if(!Number.isSafeInteger(frame)||frame<0||!Number.isSafeInteger(frameRate.numerator)||!Number.isSafeInteger(frameRate.denominator)||frameRate.numerator<=0||frameRate.denominator<=0) {
    throw new Error("Frame and frame-rate values must be non-negative integers with a positive rational frame rate.");
  }
  return frame*frameRate.denominator/frameRate.numerator;
}

export function secondsToFrame(seconds:number, frameRate:{numerator:number;denominator:number}):number {
  if(!Number.isFinite(seconds)||seconds<0||frameRate.numerator<=0||frameRate.denominator<=0) {
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

/** Convert a scrubber frame offset into a clamped source timestamp. */
export function previewSecondsAtScrubFrame(frame:number,sourceStart:number,sourceFrameRate:number,sourceEnd:number):number {
  if(!Number.isSafeInteger(frame)||frame<0||!Number.isFinite(sourceStart)||sourceStart<0||!Number.isFinite(sourceEnd)||sourceEnd<sourceStart||!Number.isFinite(sourceFrameRate)||sourceFrameRate<=0) {
    throw new Error("Scrub frame and source bounds must be valid and the source frame rate must be positive.");
  }
  return clampPreviewSeconds(sourceStart+frame/sourceFrameRate,sourceStart,sourceEnd);
}
