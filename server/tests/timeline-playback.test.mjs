import test from "node:test";
import assert from "node:assert/strict";
import { createTimeline, addTrack, addClip, rational, validateTimeline, splitClip, trimClip, toOpenTimelineIo } from "../../src/core/timeline.ts";
import { clampTimelineFrame, frameToTimelineSeconds, getTimelinePlaybackFrame, timelineClipMediaTimeSeconds, timelineDurationSeconds, timelineSecondsToFrame, selectTimelinePreviewAsset, isTimelinePreviewUrlFresh, shouldRetryTimelinePreviewUrl, shouldFallbackToTimelineSourcePreview } from "../../src/core/timeline-playback.ts";

function fixture(){
 let timeline=createTimeline("project-1","timeline-1","Playback",{numerator:30000,denominator:1001});
 timeline=addTrack(timeline,{id:"v1",name:"Picture 1",kind:"video",enabled:true,locked:false,clips:[]});
 timeline=addTrack(timeline,{id:"v2",name:"Picture 2",kind:"video",enabled:true,locked:false,clips:[]});
 timeline=addTrack(timeline,{id:"a1",name:"Music",kind:"audio",enabled:true,locked:false,clips:[]});
 timeline=addTrack(timeline,{id:"o1",name:"Graphics",kind:"overlay",enabled:true,locked:false,clips:[]});
 timeline=addTrack(timeline,{id:"c1",name:"Captions",kind:"caption",enabled:true,locked:false,clips:[]});
 const add=(trackId,id,start,duration,kindRate=30,sourceIn=0,speed=1)=>{timeline=addClip(timeline,trackId,{id,assetId:"asset-"+id,name:id,sourceRange:{start:rational(sourceIn,kindRate),duration:rational(duration,30)},timelineStart:rational(start,30),duration:rational(duration,30),enabled:true,speed});};
 add("v1","v1-a",0,90,30,30);
 add("v2","v2-a",30,60);
 add("a1","audio-a",0,120);
 add("o1","overlay-a",45,30);
 add("c1","caption-a",0,60);
 return timeline;
}

test("playback frame selects all overlapping enabled picture, audio and overlay clips in track order",()=>{
 const frame=getTimelinePlaybackFrame(fixture(),2);
 assert.deepEqual(frame.active.map(item=>item.clipId),["v1-a","v2-a","audio-a","overlay-a"]);
 assert.equal(frame.activeVideo.length,2);
 assert.equal(frame.activeAudio.length,1);
 assert.equal(frame.activeImages.length,1);
 assert.equal(frame.active.some(item=>item.clipId==="caption-a"),false);
 assert.equal(frame.activeVideo[0].mediaTimeSeconds,3);
 assert.equal(frame.activeVideo[1].mediaTimeSeconds,1);
});

test("variable-speed preview maps source time and current playback rate from keyframes",()=>{
 const timeline=createTimeline("project-speed","timeline-speed","Speed preview",{numerator:24,denominator:1});
 const withTrack=addTrack(timeline,{id:"video",name:"Video",kind:"video",enabled:true,locked:false,clips:[]});
 const clip={id:"speed",assetId:"asset-speed",name:"Speed ramp",sourceRange:{start:rational(0,24),duration:rational(144,24)},timelineStart:rational(0,24),duration:rational(96,24),enabled:true,speed:1,speedCurve:[{timeSeconds:0,speed:1},{timeSeconds:2,speed:2},{timeSeconds:4,speed:1}]};
 const added=addClip(withTrack,"video",clip);
 const frame=getTimelinePlaybackFrame(added,1);
 assert.equal(frame.active[0].mediaTimeSeconds,1.25);
 assert.equal(frame.active[0].speed,1.5);
 const midpoint=getTimelinePlaybackFrame(added,2);
 assert.equal(midpoint.active[0].mediaTimeSeconds,3);
 assert.equal(midpoint.active[0].speed,2);
});

test("playback honors clip source in-points and half-open clip boundaries",()=>{
 const timeline=fixture();
 const atOne=getTimelinePlaybackFrame(timeline,0.9);
 assert.equal(atOne.active.find(item=>item.clipId==="v1-a").mediaTimeSeconds,1.9);
 assert.equal(atOne.active.find(item=>item.clipId==="v2-a"),undefined);
 const atTwo=getTimelinePlaybackFrame(timeline,2);
 assert.equal(atTwo.active.find(item=>item.clipId==="v2-a").mediaTimeSeconds,1);
 const atThree=getTimelinePlaybackFrame(timeline,3);
 assert.equal(atThree.active.some(item=>item.clipId==="v2-a"),false);
 assert.equal(timelineClipMediaTimeSeconds(timeline.tracks[1].clips[0],2),1);
});

test("disabled tracks and clips are excluded from playback",()=>{
 const timeline=fixture();
 timeline.tracks[0].enabled=false;
 timeline.tracks[2].clips[0].enabled=false;
 const frame=getTimelinePlaybackFrame(timeline,1);
 assert.equal(frame.active.some(item=>item.trackId==="v1"),false);
 assert.equal(frame.active.some(item=>item.trackId==="a1"),false);
});

test("rational frame conversion uses sequence frame rate and clamps the playhead",()=>{
 const timeline=fixture();
 assert.ok(Math.abs(frameToTimelineSeconds(30,timeline)-1.001)<1e-12);
 assert.equal(timelineSecondsToFrame(1.001,timeline),30);
 assert.equal(clampTimelineFrame(-5,timeline),0);
 assert.equal(clampTimelineFrame(10000,timeline),120);
 assert.equal(timelineDurationSeconds(timeline),4);
});

test("playback at an empty timeline position yields no active media without negative time",()=>{
 const frame=getTimelinePlaybackFrame(fixture(),-2);
 assert.equal(frame.playheadSeconds,0);
 assert.deepEqual(frame.active.map(item=>item.clipId),["v1-a","audio-a"]);
});

test("preview prefers only a source-linked authorized video proxy and otherwise falls back to original",()=>{
 const source={id:"source",mediaType:"video/mp4"};
 const good={id:"proxy-good",mediaType:"video/mp4",derivativeOf:"source"};
 const unrelated={id:"proxy-other",mediaType:"video/mp4",derivativeOf:"another-source"};
 const image={id:"proxy-image",mediaType:"image/webp",derivativeOf:"source"};
 const clip={metadata:{proxyAssetId:"proxy-good"}};
 assert.equal(selectTimelinePreviewAsset(clip,source,[good,unrelated,image]),good);
 assert.equal(selectTimelinePreviewAsset({metadata:{proxyAssetId:"proxy-other"}},source,[good,unrelated]),source);
 assert.equal(selectTimelinePreviewAsset({metadata:{proxyAssetId:"proxy-image"}},source,[image]),source);
 assert.equal(selectTimelinePreviewAsset({metadata:{proxyAssetId:"missing"}},source,[]),source);
});

test("signed cloud preview URL is refreshed before expiry",()=>{
 const now=1_800_000_000_000;
 assert.equal(isTimelinePreviewUrlFresh(now+60_000,now),true);
 assert.equal(isTimelinePreviewUrlFresh(now+30_000,now),false);
 assert.equal(isTimelinePreviewUrlFresh(now+1,now),false);
 assert.equal(isTimelinePreviewUrlFresh(now-1,now),false);
});

test("signed cloud preview URL freshness rejects invalid timestamps and unsafe renewal windows",()=>{
 const now=1_800_000_000_000;
 assert.equal(isTimelinePreviewUrlFresh(Number.NaN,now),false);
 assert.equal(isTimelinePreviewUrlFresh(now+60_000,Number.NaN),false);
 assert.equal(isTimelinePreviewUrlFresh(now+60_000,now,-1),false);
 assert.equal(isTimelinePreviewUrlFresh(now+60_000,now,Number.POSITIVE_INFINITY),false);
});

test("cloud preview recovery permits exactly one signed URL renewal per asset",()=>{
 assert.equal(shouldRetryTimelinePreviewUrl("cloud","asset-1",[]),true);
 assert.equal(shouldRetryTimelinePreviewUrl("cloud","asset-1",["asset-1"]),false);
 assert.equal(shouldRetryTimelinePreviewUrl("local","asset-1",[]),false);
 assert.equal(shouldRetryTimelinePreviewUrl("cloud","",[]),false);
});
test("proxy recovery falls back only to the matching canonical source and only once",()=>{
 assert.equal(shouldFallbackToTimelineSourcePreview(true,"source-1","proxy-1",[]),true);
 assert.equal(shouldFallbackToTimelineSourcePreview(false,"source-1","proxy-1",[]),false);
 assert.equal(shouldFallbackToTimelineSourcePreview(true,"source-1","source-1",[]),false);
 assert.equal(shouldFallbackToTimelineSourcePreview(true,"source-1","proxy-2",["proxy-2"]),false);
 assert.equal(shouldFallbackToTimelineSourcePreview(true,"","proxy-1",[]),false);
});


function transitionFixture(){
 let timeline=createTimeline("project-transition","timeline-transition","Transition preview",{numerator:24,denominator:1});
 timeline=addTrack(timeline,{id:"video",name:"Picture",kind:"video",enabled:true,locked:false,clips:[]});
 const clip=(id,start)=>({id,assetId:"asset-"+id,name:id,sourceRange:{start:rational(0,24),duration:rational(24,24)},timelineStart:rational(start,24),duration:rational(24,24),enabled:true});
 timeline=addClip(timeline,"video",clip("outgoing",0));
 timeline=addClip(timeline,"video",clip("incoming",24));
 timeline.tracks[0].clips[0].transitionToNext={type:"dip-to-black",fadeFrames:6};
 return timeline;
}

test("audio crossfade preview applies matching linear envelopes to outgoing and incoming clips",()=>{
 const timeline=createTimeline("project-audio-crossfade","timeline-audio-crossfade","Audio crossfade",{numerator:24,denominator:1});
 let withTrack=addTrack(timeline,{id:"audio",name:"Music",kind:"audio",enabled:true,locked:false,clips:[]});
 const clip=(id,start,transitionToNext)=>({id,assetId:"asset-"+id,name:id,sourceRange:{start:rational(0,24),duration:rational(24,24)},timelineStart:rational(start,24),duration:rational(24,24),enabled:true,...(transitionToNext?{transitionToNext}:{})});
 withTrack=addClip(withTrack,"audio",clip("outgoing",0));
 withTrack=addClip(withTrack,"audio",clip("incoming",24));
 withTrack.tracks[0].clips[0].transitionToNext={type:"crossfade",fadeFrames:6};
 withTrack.tracks[0].clips[1].timelineStart=rational(18,24);
 const start=getTimelinePlaybackFrame(withTrack,0.75).activeAudio;
 const midpoint=getTimelinePlaybackFrame(withTrack,0.875).activeAudio;
 const end=getTimelinePlaybackFrame(withTrack,1).activeAudio;
 assert.equal(start.length,2);
 assert.ok(Math.abs(start.find(item=>item.clipId==="outgoing").transitionGain-1)<0.001);
 assert.ok(Math.abs(start.find(item=>item.clipId==="incoming").transitionGain)<0.001);
 assert.ok(Math.abs(midpoint.find(item=>item.clipId==="outgoing").transitionGain-0.5)<0.001);
 assert.ok(Math.abs(midpoint.find(item=>item.clipId==="incoming").transitionGain-0.5)<0.001);
 assert.ok(Math.abs(end.find(item=>item.clipId==="outgoing").transitionGain)<0.001);
 assert.ok(Math.abs(end.find(item=>item.clipId==="incoming").transitionGain-1)<0.001);
 assert.equal(validateTimeline(withTrack).valid,true);
});

test("dip-to-black transitions validate and round-trip through OpenTimelineIO metadata",()=>{
 const timeline=transitionFixture();
 assert.equal(validateTimeline(timeline).valid,true);
 const otio=toOpenTimelineIo(timeline);
 assert.equal(otio.tracks.children[0].children[0].metadata.executiveVisuals.transitionToNext.type,"dip-to-black");
 assert.equal(otio.tracks.children[0].children[0].metadata.executiveVisuals.transitionToNext.fadeFrames,6);
});

test("dip-to-black preview fades the outgoing clip to black and brings the next clip up",()=>{
 const timeline=transitionFixture();
 const outgoing=getTimelinePlaybackFrame(timeline,0.875).active.find(item=>item.clipId==="outgoing");
 const atCut=getTimelinePlaybackFrame(timeline,1).active.find(item=>item.clipId==="incoming");
 const incoming=getTimelinePlaybackFrame(timeline,1.125).active.find(item=>item.clipId==="incoming");
 const complete=getTimelinePlaybackFrame(timeline,1.25).active.find(item=>item.clipId==="incoming");
 assert.ok(Math.abs(outgoing.opacity-0.5)<0.001);
 assert.equal(atCut.opacity,0);
 assert.ok(Math.abs(incoming.opacity-0.5)<0.001);
 assert.equal(complete.opacity,1);
});

test("invalid transition length, non-adjacent clips and non-video transitions are rejected",()=>{
 const timeline=transitionFixture();
 const invalidLength=structuredClone(timeline);invalidLength.tracks[0].clips[0].transitionToNext.fadeFrames=0;
 assert.ok(validateTimeline(invalidLength).issues.some(issue=>issue.code==="invalid_transition"));
 const nonAdjacent=structuredClone(timeline);nonAdjacent.tracks[0].clips[1].timelineStart=rational(30,24);
 assert.ok(validateTimeline(nonAdjacent).issues.some(issue=>issue.code==="transition_requires_adjacent_clip"));
 const nonVideo=structuredClone(timeline);nonVideo.tracks[0].kind="audio";
 assert.ok(validateTimeline(nonVideo).issues.some(issue=>issue.code==="invalid_transition"));
});

test("splitting a transitioned clip keeps its outgoing transition only on the right-hand segment",()=>{
 const timeline=transitionFixture();
 const split=splitClip(timeline,"video","outgoing",12,"outgoing-right");
 const first=split.tracks[0].clips.find(item=>item.id==="outgoing");
 const second=split.tracks[0].clips.find(item=>item.id==="outgoing-right");
 assert.equal(first.transitionToNext,undefined);
 assert.deepEqual(second.transitionToNext,{type:"dip-to-black",fadeFrames:6});
});

test("trimming the outgoing edge removes a transition whose adjacency would be broken",()=>{
 const timeline=transitionFixture();
 const trimmed=trimClip(timeline,"video","outgoing",0,1);
 assert.equal(trimmed.tracks[0].clips.find(item=>item.id==="outgoing").transitionToNext,undefined);
});
