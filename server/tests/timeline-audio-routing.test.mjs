import test from "node:test";
import assert from "node:assert/strict";
import {selectAudibleAudioTracks} from "../timeline-audio-routing.mjs";

const audio=(id,overrides={})=>({id,kind:"audio",enabled:true,clips:[{id:id+"-clip"}],...overrides});

test("keeps all enabled audio tracks when no mute or solo state is set",()=>{
 const tracks=[audio("voice"),audio("music"),{id:"video",kind:"video"}];
 assert.deepEqual(selectAudibleAudioTracks(tracks).map(track=>track.id),["voice","music"]);
});

test("excludes muted audio tracks without changing other tracks",()=>{
 const tracks=[audio("voice"),audio("music",{muted:true}),audio("fx")];
 assert.deepEqual(selectAudibleAudioTracks(tracks).map(track=>track.id),["voice","fx"]);
});

test("solo routes only soloed unmuted audio tracks",()=>{
 const tracks=[audio("voice"),audio("music",{solo:true}),audio("fx",{solo:true}),audio("muted-solo",{solo:true,muted:true})];
 assert.deepEqual(selectAudibleAudioTracks(tracks).map(track=>track.id),["music","fx"]);
});

test("a muted solo track remains silent and does not unmute non-solo tracks",()=>{
 const tracks=[audio("voice"),audio("music",{solo:true,muted:true})];
 assert.deepEqual(selectAudibleAudioTracks(tracks),[]);
});

test("disabled tracks are excluded from solo routing",()=>{
 const tracks=[audio("voice"),audio("disabled-solo",{solo:true,enabled:false})];
 assert.deepEqual(selectAudibleAudioTracks(tracks).map(track=>track.id),["voice"]);
});

test("rejects malformed track collections",()=>{
 assert.throws(()=>selectAudibleAudioTracks(null),/array/);
});
