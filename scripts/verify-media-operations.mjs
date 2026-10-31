import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp,stat,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildMediaOperationArgs} from "../server/media.mjs";
const base={sourcePath:"/private/source.mp4",outputPath:"/private/output.mp4"};
const cases=[
 ["media.denoise",{luma:5,chroma:2},"hqdn3d=5.00:2.00:3.75:1.50"],
 ["media.color",{brightness:0.1,contrast:1.2,saturation:1.4},"eq=brightness=0.100:contrast=1.200:saturation=1.400"],
 ["media.resize",{width:320,height:180,fit:"contain"},"scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"],
 ["media.resize",{width:320,height:180,fit:"cover"},"scale=320:180:force_original_aspect_ratio=increase,crop=320:180,setsar=1"],
 ["media.interpolate",{fps:30},"minterpolate=fps=30.000:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"],
 ["media.upscale",{width:640,height:360},"scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"]
];
for(const [kind,input,expected] of cases){
 const args=buildMediaOperationArgs({jobType:kind,input,...base});
 assert.equal(args[args.indexOf("-vf")+1],expected,kind+" filter must be deterministic");
 assert.equal(args.at(-1),base.outputPath);
 assert.ok(args.includes("libx264"));
}
assert.throws(()=>buildMediaOperationArgs({jobType:"media.denoise",input:{luma:99},...base}),e=>e.code==="INVALID_MEDIA_OPTIONS");
assert.throws(()=>buildMediaOperationArgs({jobType:"media.color",input:{brightness:2},...base}),e=>e.code==="INVALID_MEDIA_OPTIONS");
assert.throws(()=>buildMediaOperationArgs({jobType:"media.resize",input:{width:1280,height:720,fit:"stretch"},...base}),e=>e.code==="INVALID_MEDIA_OPTIONS");
assert.throws(()=>buildMediaOperationArgs({jobType:"media.interpolate",input:{fps:120},...base}),e=>e.code==="INVALID_MEDIA_OPTIONS");
assert.throws(()=>buildMediaOperationArgs({jobType:"media.execute-shell",input:{},...base}),e=>e.code==="INVALID_MEDIA_OPTIONS");
const audioArgs=buildMediaOperationArgs({jobType:"media.audio-clean",input:{noiseFloor:-30,targetLufs:-18},sourcePath:base.sourcePath,outputPath:"/private/cleaned.wav"});\nassert.equal(audioArgs[audioArgs.indexOf("-af")+1],"afftdn=nf=-30.0:tn=1,loudnorm=I=-18.0:TP=-1.5:LRA=11");\nassert.ok(audioArgs.includes("pcm_s16le"));\nassert.throws(()=>buildMediaOperationArgs({jobType:"media.audio-clean",input:{noiseFloor:-90},sourcePath:base.sourcePath,outputPath:base.outputPath}),e=>e.code==="INVALID_MEDIA_OPTIONS");\nconst root=await mkdtemp(join(tmpdir(),"executive-visuals-enhancement-"));
try{
 const ffmpeg=process.env.FFMPEG_PATH||"ffmpeg",ffprobe=process.env.FFPROBE_PATH||"ffprobe",source=join(root,"source.mp4");
 execFileSync(ffmpeg,["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","testsrc=size=320x180:rate=24","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","1","-c:v","libx264","-pix_fmt","yuv420p","-c:a","aac",source],{stdio:"pipe",timeout:60000});
 const audioSource=join(root,"source.wav"),cleaned=join(root,"cleaned.wav");\n execFileSync(ffmpeg,["-hide_banner","-loglevel","error","-y","-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","1","-c:a","pcm_s16le",audioSource],{stdio:"pipe",timeout:60000});\n const cleanArgs=buildMediaOperationArgs({jobType:"media.audio-clean",input:{noiseFloor:-25,targetLufs:-16},sourcePath:audioSource,outputPath:cleaned});\n execFileSync(ffmpeg,cleanArgs,{stdio:"pipe",timeout:120000});\n assert.ok((await stat(cleaned)).size>1000,"audio cleanup must produce a non-empty WAV");\n const audioMetadata=JSON.parse(execFileSync(ffprobe,["-v","error","-show_entries","stream=codec_type,sample_rate","-of","json",cleaned],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}));\n assert.ok(audioMetadata.streams.some(stream=>stream.codec_type==="audio"),"cleaned output must contain an audio stream");\n for(let index=0;index<cases.length;index++){
  const [kind,input]=cases[index],output=join(root,"result-"+index+".mp4");
  const args=buildMediaOperationArgs({jobType:kind,input,sourcePath:source,outputPath:output});
  execFileSync(ffmpeg,args,{stdio:"pipe",timeout:120000});
  assert.ok((await stat(output)).size>1000,kind+" must produce a non-empty MP4");
  const metadata=JSON.parse(execFileSync(ffprobe,["-v","error","-show_entries","stream=codec_type,width,height","-of","json",output],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
  assert.ok(metadata.streams.some(stream=>stream.codec_type==="video"),kind+" output must contain a video stream");
 }
 console.log("Verified 6 video enhancement operations and audio cleanup through FFmpeg/FFprobe, plus invalid-input rejections.");
}finally{await rm(root,{recursive:true,force:true})}
