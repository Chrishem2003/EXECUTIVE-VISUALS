/**
 * Preview-only editorial safe-area guides for caption placement.
 * These percentages are visual aids, not a broadcast-compliance certification.
 */
export interface CaptionSafeAreaGuide {
 titleInsetPercent:number;
 subtitleLeftPercent:number;
 subtitleRightPercent:number;
 subtitleBottomPercent:number;
 subtitleHeightPercent:number;
}

export function resolveCaptionSafeAreaGuide(width:number,height:number):CaptionSafeAreaGuide{
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0){
  throw new Error("A positive timeline width and height are required for safe-area preview.");
 }
 return {
  titleInsetPercent:10,
  subtitleLeftPercent:10,
  subtitleRightPercent:10,
  subtitleBottomPercent:12,
  subtitleHeightPercent:16
 };
}
