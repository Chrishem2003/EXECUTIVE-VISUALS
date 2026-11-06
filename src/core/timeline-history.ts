import type { EditorialTimeline } from "./timeline";

export interface TimelineHistory {
  undo: EditorialTimeline[];
  redo: EditorialTimeline[];
  limit: number;
}
export function createTimelineHistory(limit=50):TimelineHistory{
  return {undo:[],redo:[],limit:Math.max(1,Math.min(200,Math.floor(limit)||50))};
}
const copy=(timeline:EditorialTimeline)=>structuredClone(timeline);
export function recordTimelineHistory(history:TimelineHistory,current:EditorialTimeline):TimelineHistory{
  return {limit:history.limit,undo:[...history.undo,copy(current)].slice(-history.limit),redo:[]};
}
export function undoTimeline(history:TimelineHistory,current:EditorialTimeline):{history:TimelineHistory;timeline:EditorialTimeline|null}{
  if(!history.undo.length)return {history,timeline:null};
  const previous=history.undo[history.undo.length-1];
  return {history:{limit:history.limit,undo:history.undo.slice(0,-1),redo:[...history.redo,copy(current)].slice(-history.limit)},timeline:copy(previous)};
}
export function redoTimeline(history:TimelineHistory,current:EditorialTimeline):{history:TimelineHistory;timeline:EditorialTimeline|null}{
  if(!history.redo.length)return {history,timeline:null};
  const next=history.redo[history.redo.length-1];
  return {history:{limit:history.limit,undo:[...history.undo,copy(current)].slice(-history.limit),redo:history.redo.slice(0,-1)},timeline:copy(next)};
}
