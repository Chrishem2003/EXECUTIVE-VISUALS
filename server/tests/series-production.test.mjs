import assert from "node:assert/strict";
import {buildSeriesProductionPlan,validateSeriesProductionPlan,buildEpisodeTimelineDocument,upsertStoryBibleEntry,setEpisodeDirectionOverrides,resolveEpisodeDirection,buildEpisodeShotPackage,MAX_EPISODE_SECONDS,MAX_GENERATED_CLIP_SECONDS} from "../../src/core/series-production.ts";
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

const withBible=upsertStoryBibleEntry(plan,{kind:"character",name:"Host One",description:"Recurring presenter",visualRules:"Keep jacket and hairstyle consistent.",tags:["host","presenter"],referenceAssetIds:[]});
assert.equal(withBible.storyBible.entries.length,1);assert.equal(withBible.storyBible.entries[0].kind,"character");
const withPlace=upsertStoryBibleEntry(withBible,{kind:"location",name:"Studio A",description:"Main interview set",visualRules:"Warm key light.",tags:["interior"],referenceAssetIds:[]});
assert.equal(withPlace.storyBible.entries.length,2);
const target=withPlace.seasons[0].episodes[0];
const overridden=setEpisodeDirectionOverrides(withPlace,target.id,{episodeRuntimeSeconds:240,aspectRatio:"9:16",visualStyle:"Noir documentary",cameraLanguage:"Handheld intimate"});
const updated=overridden.seasons[0].episodes[0],direction=resolveEpisodeDirection(overridden,updated);
assert.equal(updated.runtimeSeconds,240);assert.equal(direction.episodeRuntimeSeconds,240);assert.equal(direction.aspectRatio,"9:16");
assert.equal(updated.scenes.reduce((n,scene)=>n+scene.durationSeconds,0),240);
assert.equal(updated.scenes.reduce((n,scene)=>n+scene.shots.reduce((m,shot)=>m+shot.durationSeconds,0),0),240);
assert.ok(updated.scenes.every(scene=>scene.shots.every(shot=>shot.durationSeconds<=30)));
const verticalTimeline=buildEpisodeTimelineDocument(overridden,updated,"project-123");
assert.equal(verticalTimeline.width,1080);assert.equal(verticalTimeline.height,1920);
assert.equal(verticalTimeline.markers.filter(marker=>marker.color==="#29a38b").reduce((n,marker)=>n+marker.duration.value,0),240);
assert.throws(()=>setEpisodeDirectionOverrides(plan,target.id,{episodeRuntimeSeconds:301}),/up to five minutes/);
assert.throws(()=>upsertStoryBibleEntry(plan,{kind:"unknown",name:"X",description:"Y",visualRules:"",tags:[],referenceAssetIds:[]}),/record type/);
console.log("Story bible and episode override verification passed: registry, inheritance, runtime rebalance, vertical timeline and five-minute cap.");

const resetPlan=setEpisodeDirectionOverrides(overridden,updated.id,{});
const resetEpisode=resetPlan.seasons[0].episodes[0];
assert.equal(resetEpisode.runtimeSeconds,plan.defaults.episodeRuntimeSeconds);
assert.equal(resetEpisode.scenes.reduce((n,scene)=>n+scene.durationSeconds,0),plan.defaults.episodeRuntimeSeconds);
assert.equal(resolveEpisodeDirection(resetPlan,resetEpisode).aspectRatio,plan.defaults.aspectRatio);
console.log("Episode override reset verification passed: series defaults restored and scene durations rebalanced.");

const explicitlyBound=structuredClone(overridden);for(const scene of explicitlyBound.seasons[0].episodes[0].scenes)scene.storyBibleEntryIds=[withBible.storyBible.entries[0].id];
const shotPack=buildEpisodeShotPackage(explicitlyBound,explicitlyBound.seasons[0].episodes[0]);
assert.equal(shotPack.runtimeSeconds,240);assert.equal(shotPack.totalShotSeconds,240);assert.equal(shotPack.shotCount,updated.scenes.reduce((n,scene)=>n+scene.shots.length,0));
assert.equal(shotPack.shots[0].aspectRatio,"9:16");assert.equal(shotPack.shots[0].visualStyle,"Noir documentary");
assert.ok(shotPack.shots.every(shot=>shot.prompt.includes("Future Makers")&&shot.prompt.includes("Noir documentary")));
assert.ok(shotPack.shots.every(shot=>shot.negativePrompt.includes("character identity")));
assert.ok(shotPack.shots.every(shot=>shot.continuityContext.some(rule=>rule.includes("Host One"))));
assert.deepEqual(shotPack.shots[0].referenceAssetIds,[]);
assert.equal(shotPack.schemaVersion,1);
assert.throws(()=>buildEpisodeShotPackage(plan,{...episode,id:"foreign-episode"}),/does not belong/);
console.log("Shot package verification passed: deterministic shot prompts, continuity bible, direction inheritance, exact runtime and safe provider-neutral handoff.");


const bindingBase=withBible.storyBible.entries[0];
const bindingScene=withBible.seasons[0].episodes[0].scenes[0];
const bindingShot=bindingScene.shots[0];
const boundPlan=structuredClone(withBible);
boundPlan.seasons[0].episodes[0].scenes[0].storyBibleEntryIds=[bindingBase.id];
const boundPackage=buildEpisodeShotPackage(boundPlan,boundPlan.seasons[0].episodes[0]);
assert.ok(boundPackage.shots[0].continuityContext.some(rule=>rule.includes("Host One")));
assert.ok(boundPackage.shots[0].prompt.includes("Future Makers"));
assert.deepEqual(boundPackage.shots[0].referenceAssetIds,[]);
const unboundSceneShot=boundPackage.shots.find(item=>item.sceneId!==bindingScene.id);
assert.ok(unboundSceneShot);
assert.ok(!unboundSceneShot.continuityContext.some(rule=>rule.includes("Host One")));
const invalidBinding=structuredClone(boundPlan);
invalidBinding.seasons[0].episodes[0].scenes[0].shots[0].storyBibleEntryIds=["missing-entry"];
assert.throws(()=>buildEpisodeShotPackage(invalidBinding,invalidBinding.seasons[0].episodes[0]),/unknown story bible entry/);
assert.equal(validateSeriesProductionPlan(invalidBinding).valid,true);
const duplicateBinding=structuredClone(boundPlan);
duplicateBinding.seasons[0].episodes[0].scenes[0].storyBibleEntryIds=[bindingBase.id,bindingBase.id];
assert.equal(validateSeriesProductionPlan(duplicateBinding).valid,false);
console.log("Shot-level continuity binding verification passed: scoped entity context, inherited scene bindings, deduplicated references and unknown-ID rejection.");
