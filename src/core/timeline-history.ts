export interface TimelineHistory<T> {
  undo:T[];
  redo:T[];
}
export function createTimelineHistory<T>():TimelineHistory<T>{return{undo:[],redo:[]};}
export function recordTimelineSnapshot<T>(history:TimelineHistory<T>,previous:T,limit=50):TimelineHistory<T>{
  const max=Math.max(1,Math.min(200,Math.floor(limit)||50));
  return{undo:[...history.undo,previous].slice(-max),redo:history.redo.length?[]:history.redo};
}
export function travelTimelineHistory<T>(history:TimelineHistory<T>,current:T,direction:"undo"|"redo"):{target:T;history:TimelineHistory<T>}|null{
  const source=direction==="undo"?history.undo:history.redo;
  if(!source.length)return null;
  const target=source[source.length-1];
  return direction==="undo"
    ?{target,history:{undo:source.slice(0,-1),redo:[...history.redo,current]}}
    :{target,history:{undo:[...history.undo,current],redo:source.slice(0,-1)}};
}
