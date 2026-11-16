import test from "node:test";
import assert from "node:assert/strict";
import {buildMediaOperationArgs} from "../media.mjs";

test("soundtrack replacement copies the original video and maps only the replacement audio",()=>{
 const args=buildMediaOperationArgs({jobType:"media.audio_replace",input:{replacementAudioPath:"/private/derived/dub.mp3"},sourcePath:"/private/source.mp4",outputPath:"/private/derived/localized.mp4"});
 assert.deepEqual(args,[
  "-hide_banner","-y","-i","/private/source.mp4","-i","/private/derived/dub.mp3",
  "-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-b:a","192k",
  "-shortest","-movflags","+faststart","/private/derived/localized.mp4"
 ]);
});

test("soundtrack replacement refuses missing or untrusted local paths",()=>{
 assert.throws(()=>buildMediaOperationArgs({jobType:"media.audio_replace",sourcePath:"/private/source.mp4",outputPath:"/private/out.mp4",input:{}}),error=>error.code==="INVALID_MEDIA_OPTIONS");
 assert.throws(()=>buildMediaOperationArgs({jobType:"media.audio_replace",sourcePath:"/private/source.mp4",outputPath:"/private/out.mp4",input:{replacementAudioPath:""}}),error=>error.code==="INVALID_MEDIA_OPTIONS");
});
