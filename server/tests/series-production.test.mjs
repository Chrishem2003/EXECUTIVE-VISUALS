import assert from "node:assert/strict";
import {createGeneratedVideoClip,validateTimeline} from "../../src/core/timeline.ts";
import {buildSeriesProductionPlan,validateSeriesProductionPlan,buildEpisodeTimelineDocument,upsertStoryBibleEntry,setEpisodeDirectionOverrides,resolveEpisodeDirection,buildEpisodeShotPackage,buildSeriesPlanFromStoryboard,matchGeneratedStoryboardAssets,setEpisodeStoryBibleBindings,updateEpisodeShotDirection,MAX_EPISODE_SECONDS,MAX_GENERATED_CLIP_SECONDS,EPISODE_RUNTIME_CHOICES} from "../../src/core/series-production.ts";
const input={title:"Future Makers",premise:"A series exploring practical ideas shaping tomorrow.",format:"education",genre:"Science",seasonCount:2,episodesPerSeason:6,episodeRuntimeSeconds:300,shotLengthSeconds:8,aspectRatio:"16:9",frameRate:30,resolution:"2160p",visualStyle:"Cinematic realism",language:"English",voiceMode:"Natural narration",captions:"Both",music:"Adaptive cinematic score",cameraLanguage:"Mixed cinematic coverage",shotComposition:"Mixed shot scale",pacing:"Cinematic dramatic",colorGrade:"Natural / true-to-life",continuityNotes:"Keep presenter wardrobe consistent."};
const plan=buildSeriesProductionPlan(input);assert.equal(plan.seasons.length,2);assert.equal(plan.seasons[0].episodes.length,6);
for(const season of plan.seasons)for(const ep of season.episodes){assert.equal(ep.runtimeSeconds,input.episodeRuntimeSeconds);assert.equal(ep.scenes.reduce((n,s)=>n+s.shots.reduce((x,k)=>x+k.durationSeconds,0),0),300);for(const scene of ep.scenes)for(const shot of scene.shots)assert.ok(shot.durationSeconds<=MAX_GENERATED_CLIP_SECONDS);}
assert.equal(validateSeriesProductionPlan(plan).valid,true);
assert.throws(()=>buildSeriesProductionPlan({...input,episodeRuntimeSeconds:1801}),/1800/);assert.throws(()=>buildSeriesProductionPlan({...input,seasonCount:6}),/1 to 5/);assert.throws(()=>buildSeriesProductionPlan({...input,shotLengthSeconds:31}),/1 to 30/);
const broken=structuredClone(plan);broken.seasons[0].episodes[0].runtimeSeconds=1801;assert.equal(validateSeriesProductionPlan(broken).valid,false);
const duplicate=structuredClone(plan);duplicate.seasons[0].episodes[0].scenes[1].id=duplicate.seasons[0].episodes[0].scenes[0].id;assert.equal(validateSeriesProductionPlan(duplicate).valid,false);
console.log("Series production verification passed: multi-season planning, 30-minute cap, shot segmentation, exact runtime accounting and tamper detection.");

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
assert.throws(()=>setEpisodeDirectionOverrides(plan,target.id,{episodeRuntimeSeconds:1801}),/30 minutes/);
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
assert.equal(validateSeriesProductionPlan(invalidBinding).valid,false);
const duplicateBinding=structuredClone(boundPlan);
duplicateBinding.seasons[0].episodes[0].scenes[0].storyBibleEntryIds=[bindingBase.id,bindingBase.id];
assert.equal(validateSeriesProductionPlan(duplicateBinding).valid,false);
console.log("Shot-level continuity binding verification passed: scoped entity context, inherited scene bindings, deduplicated references and unknown-ID rejection.");

const boundScenePlan=setEpisodeStoryBibleBindings(withBible,withBible.seasons[0].episodes[0].id,withBible.seasons[0].episodes[0].scenes[0].id,null,[bindingBase.id]);
assert.deepEqual(boundScenePlan.seasons[0].episodes[0].scenes[0].storyBibleEntryIds,[bindingBase.id]);
const boundShotPlan=setEpisodeStoryBibleBindings(withBible,withBible.seasons[0].episodes[0].id,withBible.seasons[0].episodes[0].scenes[0].id,bindingShot.id,[bindingBase.id]);
assert.deepEqual(boundShotPlan.seasons[0].episodes[0].scenes[0].shots[0].storyBibleEntryIds,[bindingBase.id]);
assert.throws(()=>setEpisodeStoryBibleBindings(withBible,withBible.seasons[0].episodes[0].id,bindingScene.id,null,["unknown"]),/existing story bible/);
console.log("Scene and shot binding mutation verification passed: immutable updates and known-record enforcement.");

const shotOnlyPlan=setEpisodeStoryBibleBindings(withBible,withBible.seasons[0].episodes[0].id,bindingScene.id,bindingShot.id,[bindingBase.id]);
const shotOnlyPackage=buildEpisodeShotPackage(shotOnlyPlan,shotOnlyPlan.seasons[0].episodes[0]);
const targetShot=shotOnlyPackage.shots.find(item=>item.shotId===bindingShot.id);
const siblingShot=shotOnlyPackage.shots.find(item=>item.sceneId===bindingScene.id&&item.shotId!==bindingShot.id);
assert.ok(targetShot.continuityContext.some(rule=>rule.includes("Host One")));
assert.ok(!siblingShot.continuityContext.some(rule=>rule.includes("Host One")));
assert.deepEqual(targetShot.referenceAssetIds,[]);
console.log("Shot-only continuity isolation verification passed.");

const directedPlan=updateEpisodeShotDirection(withBible,withBible.seasons[0].episodes[0].id,bindingScene.id,bindingShot.id,{prompt:"Host enters the archive and studies the evidence.",camera:"Slow dolly-in",framing:"Medium close-up",movement:"Moves from frame right to centre",lens:"50mm",negativePrompt:"No jump cuts or identity drift."});
const directedShot=directedPlan.seasons[0].episodes[0].scenes[0].shots[0];
assert.equal(directedShot.camera,"Slow dolly-in");
assert.equal(directedShot.framing,"Medium close-up");
assert.equal(directedPlan.seasons[0].episodes[0].scenes[0].shots[1].camera,undefined);
const directedPackage=buildEpisodeShotPackage(directedPlan,directedPlan.seasons[0].episodes[0]);
assert.ok(directedPackage.shots[0].prompt.includes("Shot camera: Slow dolly-in"));
assert.equal(directedPackage.shots[0].negativePrompt,"No jump cuts or identity drift.");
assert.throws(()=>updateEpisodeShotDirection(withBible,withBible.seasons[0].episodes[0].id,bindingScene.id,bindingShot.id,{prompt:"x".repeat(2001)}),/2000 characters/);
assert.throws(()=>updateEpisodeShotDirection(withBible,withBible.seasons[0].episodes[0].id,bindingScene.id,"missing-shot",{camera:"dolly"}),/does not belong/);
console.log("Shot direction verification passed: isolated edits, prompt compilation, negative prompt and bounds.");

import { assessEpisodeShotReadiness } from "../../src/core/shot-readiness.ts";
const readinessPackage=buildEpisodeShotPackage(directedPlan,directedPlan.seasons[0].episodes[0]);
const readyCapabilities={aspectRatios:[readinessPackage.shots[0].aspectRatio],resolutions:[readinessPackage.shots[0].resolution],frameRates:[readinessPackage.shots[0].frameRate],minDurationSeconds:1,maxDurationSeconds:30,negativePrompt:true};
const readyReport=assessEpisodeShotReadiness(readinessPackage,{provider:"declared-provider",model:"declared-model",capabilities:readyCapabilities});
assert.equal(readyReport.status,"ready");
assert.equal(readyReport.readyShots,readinessPackage.shotCount);
assert.equal(readyReport.policy.providerSubmitted,false);
const unsupportedReport=assessEpisodeShotReadiness(readinessPackage,{provider:"declared-provider",model:"restricted-model",capabilities:{...readyCapabilities,aspectRatios:["1:1"],maxDurationSeconds:2}});
assert.equal(unsupportedReport.status,"blocked");
assert.ok(unsupportedReport.shots[0].unsupported.some(value=>value.startsWith("aspectRatio:")));
const unknownReport=assessEpisodeShotReadiness(readinessPackage,{provider:"unverified-provider",model:"unknown-model"});
assert.equal(unknownReport.status,"unverified");
assert.equal(unknownReport.unverifiedShots,readinessPackage.shotCount);
console.log("Shot capability preflight verification passed: explicit support, blocked mismatches, unknown declarations and no provider submission.");

import { getFalVideoCapabilities } from "../fal-video-gateway.mjs";
const falCapabilities=getFalVideoCapabilities({imageInputField:"image_url"});
const falReport=assessEpisodeShotReadiness(readinessPackage,{provider:"fal",model:"configured-fal-model",capabilities:{aspectRatios:[...falCapabilities.aspectRatios],resolutions:[...falCapabilities.resolutions],minDurationSeconds:falCapabilities.minDurationSeconds,maxDurationSeconds:falCapabilities.maxDurationSeconds,negativePrompt:falCapabilities.negativePrompt,referenceImages:falCapabilities.referenceImages}});
assert.equal(falReport.status,"blocked");
assert.ok(falReport.shots[0].unsupported.includes("negativePrompt"));
assert.ok(falReport.shots[0].unverified.some(value=>value.startsWith("frameRate:")));
assert.ok(falReport.shots[0].supported.some(value=>value.startsWith("aspectRatio:")));
console.log("Configured video adapter readiness integration passed.");

// Long-form episodic support: episode runtime may span 30 minutes while every generated shot remains <=30 seconds.
assert.equal(MAX_EPISODE_SECONDS,1800);
assert.ok(EPISODE_RUNTIME_CHOICES.includes(600));
assert.ok(EPISODE_RUNTIME_CHOICES.includes(900));
assert.ok(EPISODE_RUNTIME_CHOICES.includes(1200));
assert.ok(EPISODE_RUNTIME_CHOICES.includes(1800));
const longForm=buildSeriesProductionPlan({...input,seasonCount:1,episodesPerSeason:1,episodeRuntimeSeconds:900,shotLengthSeconds:30});
const longEpisode=longForm.seasons[0].episodes[0];
assert.equal(longEpisode.runtimeSeconds,900);
assert.equal(longEpisode.scenes.reduce((n,scene)=>n+scene.shots.reduce((m,shot)=>m+shot.durationSeconds,0),0),900);
assert.ok(longEpisode.scenes.every(scene=>scene.shots.every(shot=>shot.durationSeconds<=30)));
assert.equal(validateSeriesProductionPlan(longForm).valid,true);
const longOverride=setEpisodeDirectionOverrides(longForm,longEpisode.id,{episodeRuntimeSeconds:1800});
const extendedEpisode=longOverride.seasons[0].episodes[0];
assert.equal(extendedEpisode.runtimeSeconds,1800);
assert.equal(extendedEpisode.scenes.reduce((n,scene)=>n+scene.durationSeconds,0),1800);
assert.ok(extendedEpisode.scenes.every(scene=>scene.shots.every(shot=>shot.durationSeconds<=30)));
const longTimeline=buildEpisodeTimelineDocument(longOverride,extendedEpisode,"project-123");
assert.equal(longTimeline.markers.filter(marker=>marker.color==="#29a38b").reduce((n,marker)=>n+marker.duration.value,0),1800);
assert.throws(()=>buildSeriesProductionPlan({...input,episodeRuntimeSeconds:1801}),/1800/);
assert.throws(()=>setEpisodeDirectionOverrides(longForm,longEpisode.id,{episodeRuntimeSeconds:1801}),/30 minutes/);

// Runtime changes must preserve authored shot direction and story-bible continuity.
const continuityPlan=setEpisodeStoryBibleBindings(directedPlan,directedPlan.seasons[0].episodes[0].id,bindingScene.id,bindingShot.id,[bindingBase.id]);
const continuityEpisode=continuityPlan.seasons[0].episodes[0];
const originalAuthoredShot=continuityEpisode.scenes[0].shots.find(shot=>shot.id===bindingShot.id);
const expandedContinuity=setEpisodeDirectionOverrides(continuityPlan,continuityEpisode.id,{episodeRuntimeSeconds:1800});
const expandedEpisode=expandedContinuity.seasons[0].episodes[0];
const preservedShot=expandedEpisode.scenes[0].shots.find(shot=>shot.id===bindingShot.id);
assert.ok(preservedShot);
assert.equal(preservedShot.prompt,originalAuthoredShot.prompt);
assert.equal(preservedShot.camera,originalAuthoredShot.camera);
assert.equal(preservedShot.framing,originalAuthoredShot.framing);
assert.equal(preservedShot.movement,originalAuthoredShot.movement);
assert.equal(preservedShot.lens,originalAuthoredShot.lens);
assert.equal(preservedShot.negativePrompt,originalAuthoredShot.negativePrompt);
assert.deepEqual(preservedShot.storyBibleEntryIds,originalAuthoredShot.storyBibleEntryIds);
assert.ok(expandedEpisode.scenes[0].shots.length>continuityEpisode.scenes[0].shots.length);
assert.equal(new Set(expandedEpisode.scenes.flatMap(scene=>scene.shots.map(shot=>shot.id))).size,expandedEpisode.scenes.reduce((n,scene)=>n+scene.shots.length,0));
assert.ok(expandedEpisode.scenes.every(scene=>scene.shots.every(shot=>shot.durationSeconds>=1&&shot.durationSeconds<=MAX_GENERATED_CLIP_SECONDS)));
assert.equal(validateSeriesProductionPlan(expandedContinuity).valid,true);
console.log("Runtime rebalance continuity verification passed: authored shot IDs, camera direction, negative prompts and story-bible bindings survive expansion; new shots receive unique IDs and valid durations.");
console.log("Long-form series verification passed: 15-minute plans, 30-minute overrides, exact scene/shot timing, 30-second clip cap and timeline marker integrity.");

import { compileCreativeIntent, compileCreativeStoryboard } from "../../src/core/creative-intent.ts";
const directorPlan=compileCreativeIntent({title:"Future Makers",brief:"A community turns discarded plastic into useful building materials.",audience:"Young African entrepreneurs",channel:"YouTube",style:"Cinematic documentary",duration:"90 seconds",desiredFeeling:"possibility",differentiator:"Follow one bottle through transformation",proof:"Show the workshop and measured output",callToAction:"Visit a collection point",visualSignature:"Macro match cuts",soundSignature:"Workshop sound motif",constraints:"Secure participant releases."});
const directorBoard=compileCreativeStoryboard(directorPlan,90,8);
const converted=buildSeriesPlanFromStoryboard(directorBoard,{format:"documentary",aspectRatio:"16:9",frameRate:24,resolution:"1080p",visualStyle:"Cinematic documentary",language:"English",voiceMode:"Natural narration",captions:"Both",music:"Adaptive cinematic score",cameraLanguage:"Mixed cinematic coverage",shotComposition:"Mixed shot scale",pacing:"Cinematic dramatic",colorGrade:"Natural / true-to-life"});
const convertedEpisode=converted.seasons[0].episodes[0];
assert.equal(converted.seasons.length,1);assert.equal(convertedEpisode.scenes.length,directorBoard.sceneCount);
assert.equal(convertedEpisode.scenes.reduce((n,scene)=>n+scene.shots.reduce((m,shot)=>m+shot.durationSeconds,0),0),directorBoard.durationSeconds);
assert.equal(validateSeriesProductionPlan(converted).valid,true);
const convertedPackage=buildEpisodeShotPackage(converted,convertedEpisode);
assert.equal(convertedPackage.shotCount,directorBoard.shotCount);
assert.ok(convertedPackage.shots[0].prompt.includes("Story beat:"));
assert.ok(convertedPackage.shots.every(shot=>shot.durationSeconds<=30));
assert.throws(()=>buildSeriesPlanFromStoryboard({...directorBoard,providerSubmitted:true},{format:"documentary",aspectRatio:"16:9",frameRate:24,resolution:"1080p",visualStyle:"Cinematic",language:"English",voiceMode:"Natural",captions:"Both",music:"Score",cameraLanguage:"Mixed",shotComposition:"Mixed",pacing:"Measured",colorGrade:"Natural"}),/planning-only/);
console.log("Creative Director handoff verification passed: timed storyboard converts to a validated editable episode and engine-neutral shot package without provider execution.");


const generatedShots=convertedEpisode.scenes.flatMap(scene=>scene.shots);
const generatedAssets=generatedShots.map((shot,shotIndex)=>({
 id:"asset-"+shotIndex,projectId:"cloud-project-1",mediaType:"video/mp4",
 metadata:{operation:"video.generate",approvalId:"approval-1",shotIndex,provider:"fal",model:"test-model"}
}));
const matchedGenerated=matchGeneratedStoryboardAssets(generatedShots,[...generatedAssets].reverse(),"approval-1","cloud-project-1");
assert.deepEqual(matchedGenerated.map(item=>item.asset.id),generatedShots.map((_,index)=>"asset-"+index));
assert.deepEqual(matchedGenerated.map(item=>item.shotIndex),generatedShots.map((_,index)=>index));
assert.throws(()=>matchGeneratedStoryboardAssets(generatedShots,generatedAssets.slice(1),"approval-1","cloud-project-1"),/incomplete/);
assert.throws(()=>matchGeneratedStoryboardAssets(generatedShots,[...generatedAssets,{...generatedAssets[0],id:"duplicate-asset"}],"approval-1","cloud-project-1"),/More than one generated asset/);
assert.throws(()=>matchGeneratedStoryboardAssets(generatedShots,generatedAssets.map(asset=>({...asset,projectId:"other-project"})),"approval-1","cloud-project-1"),/different cloud project/);
assert.throws(()=>matchGeneratedStoryboardAssets(generatedShots,generatedAssets.map((asset,index)=>index===0?{...asset,metadata:{...asset.metadata,shotIndex:generatedShots.length}}:asset),"approval-1","cloud-project-1"),/invalid shot index/);
console.log("Generated storyboard asset matching verification passed: exact shot order, completeness, duplicate rejection and cloud-project isolation.");


const generatedTimeline=buildEpisodeTimelineDocument(converted,convertedEpisode,"cloud-project-1");
const generatedVideoTrack=generatedTimeline.tracks.find(track=>track.kind==="video");
assert.ok(generatedVideoTrack);
for(const {shot,asset,shotIndex} of matchedGenerated){
 const marker=generatedTimeline.markers.find(item=>item.id===shot.id);
 assert.ok(marker);
 const fps=generatedTimeline.frameRate.numerator/generatedTimeline.frameRate.denominator;
 generatedVideoTrack.clips.push(createGeneratedVideoClip({
  id:"generated-clip-"+shotIndex,assetId:asset.id,name:shot.framing||("Shot "+(shotIndex+1)),
  durationSeconds:shot.durationSeconds,frameRate:generatedTimeline.frameRate,
  startFrame:Math.round(marker.start.value/marker.start.rate*fps),
  metadata:{source:"creative-storyboard",approvalId:"approval-1",shotIndex,cloudAssetId:asset.id,cloudSha256:"a".repeat(64)}
 }));
}
assert.equal(generatedVideoTrack.clips.length,generatedShots.length);
assert.equal(validateTimeline(generatedTimeline).valid,true);
assert.deepEqual(generatedVideoTrack.clips.map(clip=>clip.assetId),generatedShots.map((_,index)=>"asset-"+index));
console.log("Generated storyboard timeline verification passed: validated video clips align with their original shot markers and approved cloud assets.");
