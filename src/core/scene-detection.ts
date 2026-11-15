/**
 * Convert source-relative FFmpeg scene-cut timestamps into timeline marker frames.
 * Scene detection is advisory: callers must retain human review before cutting media.
 */
export function mapSceneChangesToTimelineFrames(input:{
 sceneChanges:unknown;
 sourceStartSeconds:number;
 sourceDurationSeconds:number;
 timelineStartFrame:number;
 timelineDurationFrames:number;
 timelineFps:number;
 playbackSpeed?:number;
 existingMarkerFrames?:number[];
 toleranceFrames?:number;
}):number[]{
 const {sceneChanges,sourceStartSeconds,sourceDurationSeconds,timelineStartFrame,timelineDurationFrames,timelineFps}=input;
 const playbackSpeed=Number(input.playbackSpeed??1);
 const tolerance=Number.isFinite(input.toleranceFrames)?Math.max(0,Math.floor(input.toleranceFrames!)):1;
 if(!Array.isArray(sceneChanges)||!Number.isFinite(sourceStartSeconds)||sourceStartSeconds<0||
  !Number.isFinite(sourceDurationSeconds)||sourceDurationSeconds<=0||
  !Number.isFinite(timelineStartFrame)||timelineStartFrame<0||
  !Number.isFinite(timelineDurationFrames)||timelineDurationFrames<=0||
  !Number.isFinite(timelineFps)||timelineFps<=0||!Number.isFinite(playbackSpeed)||playbackSpeed<=0)return [];
 const existing=(input.existingMarkerFrames||[]).filter(Number.isFinite);
 const end=sourceStartSeconds+sourceDurationSeconds,frames:number[]=[];
 for(const raw of sceneChanges){
  const seconds=Number(raw);
  if(!Number.isFinite(seconds)||seconds<=sourceStartSeconds+0.04||seconds>=end-0.04)continue;
  const frame=Math.round(timelineStartFrame+(seconds-sourceStartSeconds)/playbackSpeed*timelineFps);
  if(frame<=timelineStartFrame||frame>=timelineStartFrame+timelineDurationFrames)continue;
  if(existing.some(value=>Math.abs(value-frame)<=tolerance)||frames.some(value=>Math.abs(value-frame)<=tolerance))continue;
  frames.push(frame);
 }
 return frames.sort((a,b)=>a-b);
}
