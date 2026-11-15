import test from "node:test";
import assert from "node:assert/strict";
import { resolveCaptionSafeAreaGuide } from "../../src/core/caption-safe-area.ts";

test("caption safe-area guide is stable across landscape, square and portrait timelines",()=>{
 const expected={titleInsetPercent:10,subtitleLeftPercent:10,subtitleRightPercent:10,subtitleBottomPercent:12,subtitleHeightPercent:16};
 for(const [width,height] of [[1920,1080],[1080,1080],[1080,1920]])assert.deepEqual(resolveCaptionSafeAreaGuide(width,height),expected);
});

test("caption safe-area guide rejects invalid timeline dimensions",()=>{
 for(const [width,height] of [[0,1080],[1920,0],[-1,1080],[1920,Number.NaN],[Number.POSITIVE_INFINITY,1080]])assert.throws(()=>resolveCaptionSafeAreaGuide(width,height),/positive timeline width and height/);
});
