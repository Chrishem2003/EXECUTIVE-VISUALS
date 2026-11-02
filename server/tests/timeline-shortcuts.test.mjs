import test from "node:test";
import assert from "node:assert/strict";
import { getTimelineHistoryShortcut } from "../../src/core/timeline-shortcuts.ts";

test("maps platform undo and redo shortcuts",()=>{
  assert.equal(getTimelineHistoryShortcut({key:"z",ctrlKey:true}),"undo");
  assert.equal(getTimelineHistoryShortcut({key:"Z",metaKey:true}),"undo");
  assert.equal(getTimelineHistoryShortcut({key:"z",ctrlKey:true,shiftKey:true}),"redo");
  assert.equal(getTimelineHistoryShortcut({key:"y",ctrlKey:true}),"redo");
  assert.equal(getTimelineHistoryShortcut({key:"y",metaKey:true}),"redo");
});
test("does not intercept typing, composition, alt shortcuts or unrelated keys",()=>{
  assert.equal(getTimelineHistoryShortcut({key:"z",ctrlKey:true,editableTarget:true}),null);
  assert.equal(getTimelineHistoryShortcut({key:"z",ctrlKey:true,isComposing:true}),null);
  assert.equal(getTimelineHistoryShortcut({key:"z",ctrlKey:true,altKey:true}),null);
  assert.equal(getTimelineHistoryShortcut({key:"x",ctrlKey:true}),null);
  assert.equal(getTimelineHistoryShortcut({key:"y",ctrlKey:true,shiftKey:true}),null);
  assert.equal(getTimelineHistoryShortcut({key:"z"}),null);
});
