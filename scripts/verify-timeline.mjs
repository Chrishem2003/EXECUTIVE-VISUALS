import assert from "node:assert/strict";
import { addClip, addMarker, addTrack, createTimeline, moveClip, rational, seconds, splitClip, toOpenTimelineIo, trimClip, validateTimeline } from "../src/core/timeline.ts";
import { analyzeTimelineQuality } from "../src/core/timeline-quality.ts";
import { generatedVideoAlreadyOnTimeline, generatedVideoDurationSeconds, selectLatestGeneratedVideoAsset } from "../src/core/generated-video-import.ts";
import { resolveCloudTimelineRefresh, shouldPreserveCloudTimelineDraft } from "../src/core/timeline-conflict.ts";

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

const generatedAssets=[
 {id:"asset-old",name:"Old output",mediaType:"video/mp4",projectId:"project-1",createdAt:"2026-11-04T10:00:00Z",metadata:{source:"video-generation",validated:true,validation:{durationSeconds:12.5}}},
 {id:"asset-new-unvalidated",name:"Unvalidated output",mediaType:"video/mp4",projectId:"project-1",createdAt:"2026-11-05T10:00:00Z",metadata:{source:"video-generation",validated:false,validation:{durationSeconds:30}}},
 {id:"asset-other-project",name:"Other project",mediaType:"video/mp4",projectId:"project-2",createdAt:"2026-11-06T10:00:00Z",metadata:{source:"video-generation",validated:true,validation:{durationSeconds:40}}},
 {id:"asset-new",name:"Newest output",mediaType:"video/webm",projectId:"project-1",createdAt:"2026-11-05T09:00:00Z",metadata:{source:"video-generation",validated:true,validation:{durationSeconds:8.25}}},
 {id:"asset-image",name:"Generated still",mediaType:"image/png",projectId:"project-1",createdAt:"2026-11-07T10:00:00Z",metadata:{source:"video-generation",validated:true}}
];
const latestGenerated=selectLatestGeneratedVideoAsset(generatedAssets,"project-1");
assert.equal(latestGenerated?.id,"asset-new");
assert.equal(generatedVideoDurationSeconds(latestGenerated),8.25);
assert.equal(generatedVideoDurationSeconds({id:"fallback",name:"Fallback",mediaType:"video/mp4",metadata:{validation:{durationSeconds:"invalid"}}}),5);
assert.equal(selectLatestGeneratedVideoAsset(generatedAssets,"project-missing"),null);
assert.equal(generatedVideoAlreadyOnTimeline({tracks:[{clips:[{assetId:"asset-new"}]}]},"asset-new"),true);
assert.equal(generatedVideoAlreadyOnTimeline({tracks:[{clips:[]}]},"asset-new"),false);
assert.equal(shouldPreserveCloudTimelineDraft({hasConflict:true,timelineId:"timeline-1",timelineProjectId:"project-1",selectedProjectId:"project-1"}),true);
assert.equal(shouldPreserveCloudTimelineDraft({hasConflict:false,timelineId:"timeline-1",timelineProjectId:"project-1",selectedProjectId:"project-1"}),false);
assert.equal(shouldPreserveCloudTimelineDraft({hasConflict:true,timelineId:"timeline-1",timelineProjectId:"project-1",selectedProjectId:"project-2"}),false);
assert.equal(shouldPreserveCloudTimelineDraft({hasConflict:true,timelineId:null,timelineProjectId:"project-1",selectedProjectId:"project-1"}),false);
const localDraft={id:"timeline-1",projectId:"project-1",name:"Unsaved local edit"};
const latestServerDraft={id:"timeline-1",projectId:"project-1",name:"Server revision"};
const otherServerDraft={id:"timeline-2",projectId:"project-1",name:"Other timeline"};
const conflictedRefresh=resolveCloudTimelineRefresh(
 {hasConflict:true,timelineId:"timeline-1",timelineProjectId:"project-1",selectedProjectId:"project-1"},
 localDraft,3,
 [{id:"timeline-1",projectId:"project-1",revision:4,timeline:latestServerDraft}]
);
assert.strictEqual(conflictedRefresh.timeline,localDraft,"refresh must retain the exact unsaved local draft object");
assert.equal(conflictedRefresh.serverRevision,3,"conflict refresh must not advance the stale expected revision");
assert.equal(conflictedRefresh.preservedLocalDraft,true);
const resolvedRefresh=resolveCloudTimelineRefresh(
 {hasConflict:true,timelineId:"timeline-1",timelineProjectId:"project-2",selectedProjectId:"project-2"},
 localDraft,3,
 [{id:"timeline-1",projectId:"project-2",revision:4,timeline:latestServerDraft}]
);
assert.strictEqual(resolvedRefresh.timeline,latestServerDraft);
assert.equal(resolvedRefresh.serverRevision,4);
assert.equal(resolvedRefresh.preservedLocalDraft,false);
const initialRefresh=resolveCloudTimelineRefresh(
 {hasConflict:false,timelineId:null,timelineProjectId:null,selectedProjectId:"project-1"},
 null,0,
 [{id:"timeline-2",projectId:"project-1",revision:2,timeline:otherServerDraft}]
);
assert.strictEqual(initialRefresh.timeline,otherServerDraft);
assert.equal(initialRefresh.serverRevision,2);


console.log("Timeline engine checks passed: rational timing, source trims, split, cross-track and same-track moves, overlap protection, markers and editorial interchange export.");
