import assert from "node:assert/strict";
import {buildSeriesProductionPlan,validateSeriesProductionPlan,MAX_EPISODE_SECONDS,MAX_GENERATED_CLIP_SECONDS} from "../../src/core/series-production.ts";
const input={title:"Future Makers",premise:"A series exploring practical ideas shaping tomorrow.",format:"education",genre:"Science",seasonCount:2,episodesPerSeason:6,episodeRuntimeSeconds:300,shotLengthSeconds:8,aspectRatio:"16:9",frameRate:30,resolution:"2160p",visualStyle:"Cinematic realism",language:"English",voiceMode:"Natural narration",captions:"Both",music:"Adaptive cinematic score",continuityNotes:"Keep presenter wardrobe consistent."};
const plan=buildSeriesProductionPlan(input);assert.equal(plan.seasons.length,2);assert.equal(plan.seasons[0].episodes.length,6);
for(const season of plan.seasons)for(const ep of season.episodes){assert.equal(ep.runtimeSeconds,MAX_EPISODE_SECONDS);assert.equal(ep.scenes.reduce((n,s)=>n+s.shots.reduce((x,k)=>x+k.durationSeconds,0),0),300);for(const scene of ep.scenes)for(const shot of scene.shots)assert.ok(shot.durationSeconds<=MAX_GENERATED_CLIP_SECONDS);}
assert.equal(validateSeriesProductionPlan(plan).valid,true);
assert.throws(()=>buildSeriesProductionPlan({...input,episodeRuntimeSeconds:301}),/300/);assert.throws(()=>buildSeriesProductionPlan({...input,seasonCount:6}),/1–5/);assert.throws(()=>buildSeriesProductionPlan({...input,shotLengthSeconds:31}),/1–30/);
const broken=structuredClone(plan);broken.seasons[0].episodes[0].runtimeSeconds=301;assert.equal(validateSeriesProductionPlan(broken).valid,false);
const duplicate=structuredClone(plan);duplicate.seasons[0].episodes[0].scenes[1].id=duplicate.seasons[0].episodes[0].scenes[0].id;assert.equal(validateSeriesProductionPlan(duplicate).valid,false);
console.log("Series production verification passed: multi-season planning, 5-minute cap, shot segmentation, exact runtime accounting and tamper detection.");
