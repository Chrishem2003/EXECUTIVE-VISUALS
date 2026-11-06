const PROFILES=Object.freeze({
 source:{width:null,height:null},
 "youtube-1080p":{width:1920,height:1080},
 "vertical-1080p":{width:1080,height:1920},
 "square-1080p":{width:1080,height:1080}
});
function rational(value){
 const [numerator,denominator]=String(value||"").split("/").map(Number);
 if(!Number.isFinite(numerator)||!Number.isFinite(denominator)||denominator===0)return null;
 return numerator/denominator;
}
function add(checks,id,expected,actual,passed){
 checks.push({id,expected,actual:actual??null,passed:Boolean(passed)});
}
export function buildDeliveryCertification({profileId="source",metadata,render={}}={}){
 const profile=PROFILES[profileId];
 if(!profile)throw Object.assign(new Error("Delivery certification profile is not supported."),{code:"INVALID_DELIVERY_PROFILE"});
 const streams=Array.isArray(metadata?.streams)?metadata.streams:[];
 const video=streams.find(stream=>stream?.codec_type==="video")||null;
 const audio=streams.find(stream=>stream?.codec_type==="audio")||null;
 const expectedWidth=profile.width||Number(render.width)||null;
 const expectedHeight=profile.height||Number(render.height)||null;
 const expectedRate=render.frameRate&&Number(render.frameRate.numerator)>0&&Number(render.frameRate.denominator)>0
  ?Number(render.frameRate.numerator)/Number(render.frameRate.denominator):null;
 const actualRate=rational(video?.avg_frame_rate)||rational(video?.r_frame_rate);
 const expectedDuration=Number(render.durationSeconds);
 const actualDuration=Number(metadata?.format?.duration??video?.duration);
 const durationTolerance=Number.isFinite(expectedDuration)?Math.max(0.5,expectedDuration*0.02):null;
 const checks=[];
 add(checks,"container","MP4",metadata?.format?.format_name,String(metadata?.format?.format_name||"").split(",").includes("mp4"));
 add(checks,"video-stream","present",video?"present":"missing",Boolean(video));
 add(checks,"video-codec","h264",video?.codec_name,video?.codec_name==="h264");
 add(checks,"pixel-format","yuv420p",video?.pix_fmt,video?.pix_fmt==="yuv420p");
 add(checks,"width",expectedWidth,video?.width,Number(video?.width)===expectedWidth);
 add(checks,"height",expectedHeight,video?.height,Number(video?.height)===expectedHeight);
 if(expectedRate!==null)add(checks,"frame-rate",expectedRate,actualRate,actualRate!==null&&Math.abs(actualRate-expectedRate)<=0.02);
 if(durationTolerance!==null)add(checks,"duration-within-tolerance",durationTolerance,Number.isFinite(actualDuration)?Math.abs(actualDuration-expectedDuration):null,Number.isFinite(actualDuration)&&Math.abs(actualDuration-expectedDuration)<=durationTolerance);
 if(Number(render.audioClips)>0){
  add(checks,"audio-stream","present",audio?"present":"missing",Boolean(audio));
  add(checks,"audio-codec","aac",audio?.codec_name,audio?.codec_name==="aac");
  add(checks,"audio-sample-rate","48000",audio?.sample_rate,String(audio?.sample_rate)==="48000");
  const videoStart=Number(video?.start_time),audioStart=Number(audio?.start_time),offset=Math.abs(videoStart-audioStart);
  add(checks,"audio-video-start-alignment","≤0.1 seconds",Number.isFinite(offset)?Number(offset.toFixed(6)):null,Number.isFinite(offset)&&offset<=0.1);
 }
 const failed=checks.filter(check=>!check.passed);
 return{
  schemaVersion:1,profileId,status:failed.length?"failed":"passed",
  generatedAt:new Date().toISOString(),
  summary:{passed:checks.length-failed.length,failed:failed.length,total:checks.length},
  checks
 };
}
