import assert from "node:assert/strict";
import {buildSeriesProductionPlan,validateSeriesProductionPlan,buildEpisodeTimelineDocument,MAX_EPISODE_SECONDS,MAX_GENERATED_CLIP_SECONDS} from "../../src/core/series-production.ts";
const input={title:"Future Makers",premise:"A series exploring practical ideas shaping tomorrow.",format:"education",genre:"Science",seasonCount:2,episodesPerSeason:6,episodeRuntimeSeconds:300,shotLengthSeconds:8,aspectRatio:"16:9",frameRate:30,resolution:"2160p",visualStyle:"Cinematic realism",language:"English",voiceMode:"Natural narration",captions:"Both",music:"Adaptive cinematic score",cameraLanguage:"Mixed cinematic coverage",shotComposition:"Mixed shot scale",pacing:"Cinematic dramatic",colorGrade:"Natural / true-to-life",continuityNotes:"Keep presenter wardrobe consistent."};
const plan=buildSeriesProductionPlan(input);assert.equal(plan.seasons.length,2);assert.equal(plan.seasons[0].episodes.length,6);
for(const season of plan.seasons)for(const ep of season.episodes){assert.equal(ep.runtimeSeconds,MAX_EPISODE_SECONDS);assert.equal(ep.scenes.reduce((n,s)=>n+s.shots.reduce((x,k)=>x+k.durationSeconds,0),0),300);for(const scene of ep.scenes)for(const shot of scene.shots)assert.ok(shot.durationSeconds<=MAX_GENERATED_CLIP_SECONDS);}
assert.equal(validateSeriesProductionPlan(plan).valid,true);
assert.throws(()=>buildSeriesProductionPlan({...input,episodeRuntimeSeconds:301}),/300/);assert.throws(()=>buildSeriesProductionPlan({...input,seasonCount:6}),/1 to 5/);assert.throws(()=>buildSeriesProductionPlan({...input,shotLengthSeconds:31}),/1 to 30/);
const broken=structuredClone(plan);broken.seasons[0].episodes[0].runtimeSeconds=301;assert.equal(validateSeriesProductionPlan(broken).valid,false);
const duplicate=structuredClone(plan);duplicate.seasons[0].episodes[0].scenes[1].id=duplicate.seasons[0].episodes[0].scenes[0].id;assert.equal(validateSeriesProductionPlan(duplicate).valid,false);
console.log("Series production verification passed: multi-season planning, 5-minute cap, shot segmentation, exact runtime accounting and tamper detection.");

const episode=plan.seasons[0].episodes[0],timeline=buildEpisodeTimelineDocument(plan,episode,"project-123");
assert.equal(timeline.tracks.length,4);assert.equal(timeline.markers.filter(marker=>marker.color==="#6c8cff").length,episode.scenes.length);
assert.equal(timeline.markers.filter(marker=>marker.color==="#29a38b").length,episode.scenes.reduce((n,scene)=>n+scene.shots.length,0));
assert.equal(timeline.markers.filter(marker=>marker.color==="#29a38b").reduce((n,marker)=>n+marker.duration.value,0),episode.runtimeSeconds);
assert.equal(timeline.width,1920);assert.equal(timeline.height,1080);
assert.throws(()=>buildEpisodeTimelineDocument(plan,episode,""),/cloud project/);
const foreign=structuredClone(episode);foreign.id="not-in-series";assert.throws(()=>buildEpisodeTimelineDocument(plan,foreign,"project-123"),/does not belong/);
console.log("Episode timeline verification passed: scene and shot markers, track scaffold, aspect ratio, exact duration and ownership checks.");
