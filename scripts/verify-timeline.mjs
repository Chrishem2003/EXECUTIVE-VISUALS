import assert from "node:assert/strict";
import { addClip, addMarker, addTrack, createTimeline, evaluateTimelineAtFrame, moveClip, rational, seconds, splitClip, toOpenTimelineIo, trimClip, validateTimeline } from "../src/core/timeline.ts";
import { analyzeTimelineQuality } from "../src/core/timeline-quality.ts";

let timeline=createTimeline("project-1","timeline-1","Pilot episode",{numerator:24,denominator:1});
timeline=addTrack(timeline,{id:"v1",name:"Video 1",kind:"video",enabled:true,locked:false,clips:[]});
timeline=addTrack(timeline,{id:"v2",name:"Overlays",kind:"overlay",enabled:true,locked:false,clips:[]});
timeline=addClip(timeline,"v1",{id:"clip-a",assetId:"asset-a",name:"Opening",sourceRange:{start:rational(0,24),duration:rational(240,24)},timelineStart:rational(0,24),duration:rational(240,24),enabled:true});
timeline=addClip(timeline,"v1",{id:"clip-b",assetId:"asset-b",name:"Second scene",sourceRange:{start:rational(0,24),duration:rational(120,24)},timelineStart:rational(300,24),duration:rational(120,24),enabled:true});
assert.equal(validateTimeline(timeline).valid,true);
timeline=trimClip(timeline,"v1","clip-a",24,24);
const trimmed=timeline.tracks[0].clips.find(x=>x.id==="clip-a");
assert.equal(trimmed.sourceRange.start.value,24);
assert.equal(trimmed.sourceRange.duration.value,192);
assert.equal(trimmed.timelineStart.value,24);
assert.equal(trimmed.duration.value,192);
timeline=splitClip(timeline,"v1","clip-a",120,"clip-a-part-b");
assert.equal(timeline.tracks[0].clips.length,3);
const partB=timeline.tracks[0].clips.find(x=>x.id==="clip-a-part-b");
assert.equal(partB.sourceRange.start.value,120);
assert.equal(partB.sourceRange.duration.value,96);
assert.equal(partB.timelineStart.value,120);
timeline=moveClip(timeline,"v1","clip-b","v2",500);
assert.equal(timeline.tracks[0].clips.some(x=>x.id==="clip-b"),false);
assert.equal(timeline.tracks[1].clips[0].timelineStart.value,500);
timeline=moveClip(timeline,"v1","clip-a-part-b","v1",150);
assert.equal(timeline.tracks[0].clips.some(x=>x.id==="clip-a-part-b"),true);
assert.equal(validateTimeline(timeline).valid,true);
timeline=addMarker(timeline,{id:"marker-1",name:"Review hook",start:rational(144,24),color:"YELLOW",note:"Check the opening"});
const interchange=toOpenTimelineIo(timeline);
assert.equal(interchange.OTIO_SCHEMA,"Timeline.1");
assert.equal(interchange.tracks.children.length,2);
assert.equal(interchange.markers.length,1);
assert.equal(interchange.markers[0].name,"Review hook");
assert.ok(JSON.stringify(interchange).includes("asset://asset-a"));
assert.ok(seconds(rational(48,24))===2);

const overlap={...timeline,tracks:timeline.tracks.map(track=>track.id==="v1"?{...track,clips:[...track.clips,{id:"overlap",assetId:"asset-x",name:"Overlap",sourceRange:{start:rational(0,24),duration:rational(60,24)},timelineStart:rational(60,24),duration:rational(60,24),enabled:true}]}:track)};
assert.equal(validateTimeline(overlap).issues.some(x=>x.code==="overlap"),true);
assert.throws(()=>toOpenTimelineIo(overlap),/overlap/);
assert.throws(()=>addClip(createTimeline("project-speed","timeline-speed","Speed test"),"missing-track",{
 id:"speed-clip",assetId:"asset-speed",name:"Unsupported speed",
 sourceRange:{start:rational(0,24),duration:rational(48,24)},
 timelineStart:rational(0,24),duration:rational(48,24),enabled:true,speed:2
}),/Track not found/);
const speedBase=createTimeline("project-speed","timeline-speed","Speed test");
const speedTrack=addTrack(speedBase,{id:"speed-track",name:"Picture",kind:"video",enabled:true,locked:false,clips:[]});
assert.throws(()=>addClip(speedTrack,"speed-track",{
 id:"speed-clip",assetId:"asset-speed",name:"Unsupported speed",
 sourceRange:{start:rational(0,24),duration:rational(48,24)},
 timelineStart:rational(0,24),duration:rational(48,24),enabled:true,speed:2
}),/Clip speed changes are not supported/);
const legacySpeed={...speedTrack,tracks:speedTrack.tracks.map(track=>({...track,clips:[{
 id:"legacy-speed-clip",assetId:"asset-speed",name:"Legacy speed",
 sourceRange:{start:rational(0,24),duration:rational(48,24)},
 timelineStart:rational(0,24),duration:rational(48,24),enabled:true,speed:0.5
}]}))};
assert.ok(validateTimeline(legacySpeed).issues.some(issue=>issue.code==="unsupported_speed"));
const previewBase=createTimeline("project-preview","timeline-preview","Preview test",{numerator:24,denominator:1});
let previewTimeline=addTrack(previewBase,{id:"preview-video",name:"Video",kind:"video",enabled:true,locked:false,clips:[]});
previewTimeline=addTrack(previewTimeline,{id:"preview-overlay",name:"Overlay",kind:"overlay",enabled:true,locked:false,clips:[]});
previewTimeline=addTrack(previewTimeline,{id:"preview-audio",name:"Music",kind:"audio",enabled:true,locked:false,clips:[]});
previewTimeline=addClip(previewTimeline,"preview-video",{id:"preview-clip",assetId:"preview-asset",name:"Preview shot",sourceRange:{start:rational(48,24),duration:rational(48,24)},timelineStart:rational(24,24),duration:rational(48,24),enabled:true});
previewTimeline=addClip(previewTimeline,"preview-overlay",{id:"preview-overlay-clip",assetId:"overlay-asset",name:"Overlay",sourceRange:{start:rational(0,24),duration:rational(24,24)},timelineStart:rational(36,24),duration:rational(24,24),enabled:true});
previewTimeline=addClip(previewTimeline,"preview-audio",{id:"preview-audio-clip",assetId:"audio-asset",name:"Music bed",sourceRange:{start:rational(12,24),duration:rational(48,24)},timelineStart:rational(30,24),duration:rational(48,24),enabled:true,gainDb:-6});
const previewFrame=evaluateTimelineAtFrame(previewTimeline,36);
assert.equal(previewFrame.timeSeconds,1.5);
assert.deepEqual(previewFrame.activeClips.map(x=>x.clipId),["preview-clip","preview-overlay-clip","preview-audio-clip"]);
assert.deepEqual(previewFrame.activeClips.map(x=>x.trackIndex),[0,1,2]);
assert.equal(previewFrame.activeClips[0].trackName,"Video");
assert.equal(previewFrame.activeClips[1].trackKind,"overlay");
assert.equal(previewFrame.activeClips[1].clipName,"Overlay");
assert.equal(previewFrame.activeClips[2].trackKind,"audio");
assert.equal(previewFrame.activeClips[2].clipName,"Music bed");
assert.equal(previewFrame.activeClips[2].sourceTimeSeconds,0.75);
assert.equal(previewFrame.activeClips[0].timelineStartSeconds,1);
assert.equal(previewFrame.activeClips[0].timelineEndSeconds,3);
assert.equal(previewFrame.activeClips[0].sourceTimeSeconds,2.5);
assert.equal(previewFrame.activeClips[0].sourceFrame,60);
assert.equal(evaluateTimelineAtFrame(previewTimeline,78).activeClips.length,0);
assert.throws(()=>evaluateTimelineAtFrame(previewTimeline,-1),/non-negative safe integer/);
assert.throws(()=>evaluateTimelineAtFrame(previewTimeline,1.5),/non-negative safe integer/);

const transitionBase=createTimeline("project-transition","timeline-transition","Transition test",{numerator:24,denominator:1});
let transitionTimeline=addTrack(transitionBase,{id:"transition-video",name:"Picture",kind:"video",enabled:true,locked:false,clips:[]});
transitionTimeline=addClip(transitionTimeline,"transition-video",{id:"transition-a",assetId:"asset-a",name:"Outgoing",sourceRange:{start:rational(0,24),duration:rational(48,24)},timelineStart:rational(0,24),duration:rational(48,24),enabled:true});
transitionTimeline=addClip(transitionTimeline,"transition-video",{id:"transition-b",assetId:"asset-b",name:"Incoming",sourceRange:{start:rational(0,24),duration:rational(48,24)},timelineStart:rational(48,24),duration:rational(48,24),enabled:true});
transitionTimeline.tracks[0].clips[0].transitionToNext={type:"dip-to-black",fadeFrames:12};
assert.equal(validateTimeline(transitionTimeline).valid,true);
assert.ok(Math.abs(evaluateTimelineAtFrame(transitionTimeline,42).activeClips[0].opacity-0.5)<0.001);
assert.equal(evaluateTimelineAtFrame(transitionTimeline,48).activeClips[0].opacity,0);
assert.ok(Math.abs(evaluateTimelineAtFrame(transitionTimeline,54).activeClips[0].opacity-0.5)<0.001);
assert.equal(evaluateTimelineAtFrame(transitionTimeline,60).activeClips[0].opacity,1);
const crossfadeTimeline={...transitionTimeline,tracks:transitionTimeline.tracks.map(track=>({...track,clips:track.clips.map(clip=>clip.id==="transition-a"?{...clip,transitionToNext:{type:"crossfade",fadeFrames:6}}:clip.id==="transition-b"?{...clip,timelineStart:rational(42,24)}:clip)}))};
assert.equal(validateTimeline(crossfadeTimeline).valid,true);
const crossfadeFrame=evaluateTimelineAtFrame(crossfadeTimeline,45);
assert.equal(crossfadeFrame.activeClips.length,2);
assert.ok(Math.abs(crossfadeFrame.activeClips.find(clip=>clip.clipId==="transition-a").opacity-0.5)<0.001);
assert.ok(Math.abs(crossfadeFrame.activeClips.find(clip=>clip.clipId==="transition-b").opacity-0.5)<0.001);
const invalidCrossfade={...crossfadeTimeline,tracks:crossfadeTimeline.tracks.map(track=>({...track,clips:track.clips.map(clip=>clip.id==="transition-b"?{...clip,timelineStart:rational(43,24)}:clip)}))};
assert.ok(validateTimeline(invalidCrossfade).issues.some(issue=>issue.code==="crossfade_overlap_mismatch"));

const transitionOtio=toOpenTimelineIo(transitionTimeline);
assert.ok(JSON.stringify(transitionOtio).includes('"type":"dip-to-black"'));
const invalidTransition={...transitionTimeline,tracks:transitionTimeline.tracks.map(track=>({...track,clips:track.clips.map(clip=>clip.id==="transition-b"?{...clip,timelineStart:rational(60,24)}:clip)}))};
assert.ok(validateTimeline(invalidTransition).issues.some(issue=>issue.code==="transition_requires_adjacent_clip"));
const nonVideoTransition={...transitionTimeline,tracks:transitionTimeline.tracks.map(track=>({...track,kind:"audio"}))};
assert.ok(validateTimeline(nonVideoTransition).issues.some(issue=>issue.code==="invalid_transition"));
const multiVideoTimeline=addTrack(transitionTimeline,{id:"transition-video-secondary",name:"B-roll",kind:"video",enabled:true,locked:false,clips:[]});
const multiVideoWithClip=addClip(multiVideoTimeline,"transition-video-secondary",{id:"transition-secondary-clip",assetId:"asset-c",name:"B-roll",sourceRange:{start:rational(0,24),duration:rational(24,24)},timelineStart:rational(0,24),duration:rational(24,24),enabled:true});
const multiVideoFrame=evaluateTimelineAtFrame(multiVideoWithClip,12);
assert.equal(multiVideoFrame.activeClips.filter(clip=>clip.trackKind==="video").length,2);
assert.deepEqual(multiVideoFrame.activeClips.filter(clip=>clip.trackKind==="video").map(clip=>clip.trackIndex),[0,1]);
const secondaryFadeBase=addTrack(transitionBase,{id:"secondary-fade-track",name:"B-roll fades",kind:"video",enabled:true,locked:false,clips:[]});
let secondaryFadeTimeline=addClip(secondaryFadeBase,"secondary-fade-track",{id:"secondary-fade-a",assetId:"asset-b",name:"Outgoing layer",sourceRange:{start:rational(0,24),duration:rational(24,24)},timelineStart:rational(0,24),duration:rational(24,24),enabled:true});
secondaryFadeTimeline=addClip(secondaryFadeTimeline,"secondary-fade-track",{id:"secondary-fade-b",assetId:"asset-c",name:"Incoming layer",sourceRange:{start:rational(0,24),duration:rational(24,24)},timelineStart:rational(24,24),duration:rational(24,24),enabled:true});
secondaryFadeTimeline.tracks.find(track=>track.id==="secondary-fade-track").clips[0].transitionToNext={type:"dip-to-black",fadeFrames:6};
assert.equal(validateTimeline(secondaryFadeTimeline).valid,true);
assert.ok(Math.abs(evaluateTimelineAtFrame(secondaryFadeTimeline,21).activeClips.find(clip=>clip.clipId==="secondary-fade-a").opacity-0.5)<0.001);
assert.equal(evaluateTimelineAtFrame(secondaryFadeTimeline,24).activeClips.find(clip=>clip.clipId==="secondary-fade-b").opacity,0);
assert.ok(Math.abs(evaluateTimelineAtFrame(secondaryFadeTimeline,27).activeClips.find(clip=>clip.clipId==="secondary-fade-b").opacity-0.5)<0.001);



const locked={...timeline,tracks:timeline.tracks.map(track=>track.id==="v1"?{...track,locked:true}:track)};
assert.throws(()=>moveClip(locked,"v1","clip-a","v2",600),/locked/);


const qualityTimeline=createTimeline("project-1","quality-1","Quality check",{numerator:24,denominator:1});
let quality=addTrack(qualityTimeline,{id:"quality-video",name:"Picture",kind:"video",enabled:true,locked:false,clips:[]});
quality=addTrack(quality,{id:"quality-overlay",name:"Graphics",kind:"overlay",enabled:true,locked:false,clips:[]});
quality=addClip(quality,"quality-video",{id:"quality-clip-1",assetId:"quality-asset",name:"Opening",sourceRange:{start:rational(0,24),duration:rational(48,24)},timelineStart:rational(0,24),duration:rational(48,24),enabled:true});
quality=addClip(quality,"quality-video",{id:"quality-clip-2",assetId:"quality-asset",name:"Second shot",sourceRange:{start:rational(72,24),duration:rational(48,24)},timelineStart:rational(72,24),duration:rational(48,24),enabled:true});
quality=addMarker(quality,{id:"quality-marker",name:"Late review",start:rational(240,24)});
const findings=analyzeTimelineQuality(quality,[{id:"quality-asset",name:"Source",mediaType:"video/mp4",metadata:{probe:{format:{duration:4}}}}]);
const codes=new Set(findings.map(item=>item.code));
assert.ok(codes.has("PICTURE_GAP"));
assert.ok(codes.has("NO_AUDIO"));
assert.ok(codes.has("NO_CAPTIONS"));
assert.ok(codes.has("EMPTY_OVERLAY_TRACK"));
assert.ok(codes.has("MARKER_AFTER_SEQUENCE"));
assert.ok(codes.has("SEQUENCE_DURATION"));
const outOfRange=analyzeTimelineQuality(quality,[{id:"quality-asset",metadata:{probe:{format:{duration:2}}}}]);
assert.ok(outOfRange.some(item=>item.code==="SOURCE_RANGE_EXCEEDS_MEDIA"));
assert.ok(analyzeTimelineQuality(quality,[]).some(item=>item.code==="ASSET_NOT_IN_LIBRARY"));
assert.ok(analyzeTimelineQuality(null).some(item=>item.code==="NO_SEQUENCE"));

console.log("Timeline engine checks passed: rational timing, source trims, split, cross-track and same-track moves, overlap protection, markers and editorial interchange export.");
