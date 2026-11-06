const DEFAULT_THRESHOLD=0.5;
const DEFAULT_HOLDOFF_MS=300;
const MODEL="silero-v6.2";
function finite(value){return typeof value==="number"&&Number.isFinite(value);}
function clamp(value,maximum){return Math.max(0,Math.min(maximum,value));}

export function normalizeVoiceActivityReport(report,{durationSeconds,threshold=DEFAULT_THRESHOLD,holdoffMs=DEFAULT_HOLDOFF_MS}={}){
 if(!finite(durationSeconds)||durationSeconds<=0)throw new TypeError("durationSeconds must be a positive finite number.");
 if(!finite(threshold)||threshold<0||threshold>1)throw new TypeError("threshold must be between 0 and 1.");
 if(!Number.isInteger(holdoffMs)||holdoffMs<0||holdoffMs>5000)throw new TypeError("holdoffMs must be an integer between 0 and 5000.");
 if(!report||typeof report!=="object"||Array.isArray(report)||!Array.isArray(report.segments)||!Array.isArray(report.scores))throw new TypeError("Silero VAD returned an invalid report.");
 if(report.scores.length>10000000||report.segments.length>100000)throw new RangeError("Silero VAD report exceeds the supported analysis size.");
 const scores=report.scores.map((item,index)=>{
  if(!item||!finite(item.start)||!finite(item.end)||!finite(item.vadScore)||typeof item.isSpeech!=="boolean"||item.start<0||item.end<=item.start||item.vadScore<0||item.vadScore>1||item.start>durationSeconds+0.25)throw new TypeError("Silero VAD returned an invalid score window at index "+index+".");
  const start=clamp(item.start,durationSeconds),end=clamp(item.end,durationSeconds);
  if(end<=start)throw new TypeError("Silero VAD returned an empty score window at index "+index+".");
  return {start,end,vadScore:item.vadScore,isSpeech:item.isSpeech};
 }).sort((a,b)=>a.start-b.start);
 const segments=report.segments.map((item,index)=>{
  if(!item||!finite(item.start)||!finite(item.end)||item.start<0||item.end<=item.start||item.start>durationSeconds+0.25)throw new TypeError("Silero VAD returned an invalid speech segment at index "+index+".");
  const start=clamp(item.start,durationSeconds),end=clamp(item.end,durationSeconds);
  if(end<=start)throw new TypeError("Silero VAD returned an empty speech segment at index "+index+".");
  return {start,end};
 }).sort((a,b)=>a.start-b.start);
 const merged=[];
 for(const segment of segments){
  const previous=merged.at(-1);
  if(previous&&segment.start<=previous.end){previous.end=Math.max(previous.end,segment.end);}
  else merged.push({...segment});
 }
 const speechDurationSeconds=merged.reduce((sum,item)=>sum+(item.end-item.start),0);
 const speechWindowCount=scores.filter(item=>item.isSpeech).length;
 return {
  method:"silero-neural-vad",
  model:MODEL,
  sampleRate:16000,
  threshold,
  holdoffMs,
  durationSeconds,
  windowCount:scores.length,
  speechWindowCount,
  speechDurationSeconds:Number(speechDurationSeconds.toFixed(3)),
  speechRatio:Number((speechDurationSeconds/durationSeconds).toFixed(6)),
  segments:merged
 };
}

export async function analyzeVoiceActivityFile({filePath,durationSeconds,threshold=DEFAULT_THRESHOLD,holdoffMs=DEFAULT_HOLDOFF_MS,openFile}={}){
 if(typeof filePath!=="string"||!filePath.trim()||filePath.includes("\\0"))throw new TypeError("filePath must be a non-empty path.");
 const open=typeof openFile==="function"?openFile:(await import("decibri")).File.open;
 if(typeof open!=="function")throw new TypeError("The configured audio runtime does not expose File.open().");
 const file=await open(filePath,{sampleRate:16000,channels:1,vad:{model:"silero",threshold,holdoffMs}});
 try{
  if(!file||typeof file.analyze!=="function")throw new TypeError("The audio runtime does not expose File.analyze().");
  const report=await file.analyze();
  return normalizeVoiceActivityReport(report,{durationSeconds,threshold,holdoffMs});
 }finally{
  if(typeof file?.close==="function")await file.close();
 }
}
