import test from "node:test";
import assert from "node:assert/strict";
import {
 buildTimelineSpeedCurveSegments,
 sourceDurationForTimelineClip,
 buildTimelineSpeedCurveSetptsExpression,
 buildTimelineRubberbandCommands
} from "../media.mjs";

const curve=[{timeSeconds:0,speed:1},{timeSeconds:2,speed:2},{timeSeconds:4,speed:1}];

test("local timeline speed curves integrate source duration exactly",()=>{
 const segments=buildTimelineSpeedCurveSegments({speedCurve:curve},4);
 assert.equal(segments.length,2);
 assert.equal(segments[0].sourceEnd,3);
 assert.equal(segments[1].sourceEnd,6);
 assert.equal(sourceDurationForTimelineClip({speedCurve:curve},4),6);
});

test("local timeline speed curves build an analytic inverse source-time mapping",()=>{
 const expression=buildTimelineSpeedCurveSetptsExpression({speedCurve:curve},4);
 assert.match(expression,/sqrt/);
 assert.match(expression,/lt\(T,3\)/);
 assert.equal(buildTimelineSpeedCurveSetptsExpression({speed:2},4),null);
 assert.equal(sourceDurationForTimelineClip({speed:2},4),8);
});

test("local audio speed curves produce bounded frame-sampled Rubber Band commands",()=>{
 const commands=buildTimelineRubberbandCommands({speedCurve:curve},4,24);
 const lines=commands.trim().split("\n");
 assert.equal(lines.length,95);
 assert.ok(lines.every(line=>line.includes("rubberband@rb tempo")));
 assert.match(lines[0],/^0\.042/);
});

test("local timeline speed curves clip safely to the effective render duration",()=>{
 const duration=1.25;
 const segments=buildTimelineSpeedCurveSegments({speedCurve:curve},duration);
 assert.equal(segments.length,1);
 assert.ok(Math.abs(sourceDurationForTimelineClip({speedCurve:curve},duration)-1.4453125)<1e-9);
 assert.ok(!buildTimelineRubberbandCommands({speedCurve:curve},duration,24).includes("rubberband@rb tempo 2;"));
});

test("local timeline speed curves reject malformed and excessively dense curves",()=>{
 assert.throws(()=>buildTimelineSpeedCurveSegments({speedCurve:[{timeSeconds:0,speed:1},{timeSeconds:0,speed:2}]},4),error=>error.code==="INVALID_SPEED_CURVE");
 assert.throws(()=>buildTimelineRubberbandCommands({speedCurve:[{timeSeconds:0,speed:1},{timeSeconds:5000,speed:1}]},5000,24),error=>error.code==="SPEED_CURVE_COMPLEXITY_LIMIT");
});
