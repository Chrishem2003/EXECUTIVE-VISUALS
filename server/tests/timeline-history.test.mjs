import test from "node:test";
import assert from "node:assert/strict";
import { createTimelineHistory, recordTimelineSnapshot, travelTimelineHistory } from "../../src/core/timeline-history.ts";

test("timeline history records snapshots and clears redo after a new edit",()=>{
 let history=createTimelineHistory();
 history=recordTimelineSnapshot(history,{revision:1,value:"A"});
 history=recordTimelineSnapshot(history,{revision:2,value:"B"});
 assert.deepEqual(history.undo,[{revision:1,value:"A"},{revision:2,value:"B"}]);
 history={undo:history.undo,redo:[{revision:3,value:"C"}]};
 history=recordTimelineSnapshot(history,{revision:4,value:"D"});
 assert.deepEqual(history.redo,[]);
});

test("undo and redo travel symmetrically without mutating the source history",()=>{
 const original={undo:[{value:"A"}],redo:[]},current={value:"B"};
 const undone=travelTimelineHistory(original,current,"undo");
 assert.deepEqual(undone?.target,{value:"A"});
 assert.deepEqual(undone?.history,{undo:[],redo:[{value:"B"}]});
 const redone=travelTimelineHistory(undone!.history,{value:"A"},"redo");
 assert.deepEqual(redone?.target,{value:"B"});
 assert.deepEqual(redone?.history,{undo:[{value:"A"}],redo:[]});
 assert.deepEqual(original,{undo:[{value:"A"}],redo:[]});
});

test("history is bounded and an empty direction is a no-op",()=>{
 let history=createTimelineHistory();
 for(let i=0;i<60;i++)history=recordTimelineSnapshot(history,{value:i},10);
 assert.equal(history.undo.length,10);
 assert.equal(history.undo[0].value,50);
 assert.equal(travelTimelineHistory(history,{value:60},"redo"),null);
});
