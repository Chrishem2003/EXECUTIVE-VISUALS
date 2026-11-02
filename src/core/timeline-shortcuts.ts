export type TimelineHistoryShortcutInput = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  editableTarget?: boolean;
};
export type TimelineHistoryShortcut = "undo" | "redo" | null;

export function getTimelineHistoryShortcut(input:TimelineHistoryShortcutInput):TimelineHistoryShortcut{
  if(input.isComposing||input.editableTarget||input.altKey||!(input.ctrlKey||input.metaKey))return null;
  const key=input.key.toLowerCase();
  if(key==="z")return input.shiftKey?"redo":"undo";
  if(key==="y"&&!input.shiftKey)return "redo";
  return null;
}
