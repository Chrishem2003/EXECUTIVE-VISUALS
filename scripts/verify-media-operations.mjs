import assert from "node:assert/strict";
import {buildMediaOperationArgs} from "../server/media.mjs";
const base={sourcePath:"/private/source.mp4",outputPath:"/private/output.mp4"};
const cases=[
 ["media.denoise",{luma:5,chroma:2},"hqdn3d=5.00:2.00:3.75:1.50"],
 ["media.color",{brightness:0.1,contrast:1.2,saturation:1.4},"eq=brightness=0.100:contrast=1.200:saturation=1.400"],
 ["media.resize",{width:1280,height:720,fit:"contain"},"scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"],
 ["media.resize",{width:1080,height:1920,fit:"cover"},"scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1"],
 ["media.interpolate",{fps:60},"minterpolate=fps=60.000:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1"],
 ["media.upscale",{width:3840,height:2160},"scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"]
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
console.log("Verified 6 local enhancement plans and 5 invalid-input rejections.");
