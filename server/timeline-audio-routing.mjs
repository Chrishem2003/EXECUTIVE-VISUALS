/**
 * Resolve timeline audio-track mute/solo state before building the render graph.
 * Solo is evaluated across enabled audio tracks; a muted solo track remains
 * silent, and when any track is soloed all non-solo tracks are excluded.
 */
export function selectAudibleAudioTracks(tracks){
 if(!Array.isArray(tracks))throw new TypeError("Timeline tracks must be an array.");
 const audioTracks=tracks.filter(track=>track&&track.kind==="audio"&&track.enabled!==false);
 const hasSolo=audioTracks.some(track=>track.solo===true);
 return audioTracks.filter(track=>track.muted!==true&&(!hasSolo||track.solo===true));
}
