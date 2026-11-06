import test from "node:test";
import assert from "node:assert/strict";
import { createTimeline } from "../../src/core/timeline.ts";
import { createTimelineHistory, recordTimelineHistory, undoTimeline, redoTimeline } from "../../src/core/timeline-history.ts";

const make=(name="Sequence")=>({...createTimeline("project","sequence",name),name});

test("undo restores an immutable previous timeline and enables redo",()=>{
 const before=make("Before"),after={...before,name:"After",revision:before.revision+1};
 const recorded=recordTimelineHistory(createTimelineHistory(),before);
 const undone=undoTimeline(recorded,after);
 assert.equal(undone.timeline.name,"Before");
 assert.equal(undone.history.redo.length,1);
 assert.equal(before.name,"Before","history snapshots do not mutate the original");
});

test("redo restores the next state and creates an undo point",()=>{
 const before=make("Before"),after={...before,name:"After"};
 const undone=undoTimeline(recordTimelineHistory(createTimelineHistory(),before),after);
 const redone=redoTimeline(undone.history,undone.timeline);
 assert.equal(redone.timeline.name,"After");
 assert.equal(redone.history.undo.length,1);
});

test("new edits clear redo history and history remains bounded",()=>{
 const h=createTimelineHistory(2);
 const a=make("A"),b=make("B"),c=make("C");
 const h1=recordTimelineHistory(h,a),h2=recordTimelineHistory(h1,b),h3=recordTimelineHistory(h2,c);
 assert.equal(h3.undo.length,2);
 const undo=undoTimeline(h3,{...c,name:"D"});
 const fresh=recordTimelineHistory(undo.history,undo.timeline);
 assert.equal(fresh.redo.length,0);
});

test("undo and redo on empty stacks return no timeline",()=>{
 const h=createTimelineHistory();
 assert.equal(undoTimeline(h,make()).timeline,null);
 assert.equal(redoTimeline(h,make()).timeline,null);
});
