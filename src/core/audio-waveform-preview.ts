import { extractWaveformPeaks, waveformSvg } from "./audio-preview.ts";

export interface AudioWaveformPreviewOptions {
 fetchImpl?:(url:string,init?:RequestInit)=>Promise<Response>;
 decodeAudioData?:(data:ArrayBuffer)=>Promise<Pick<AudioBuffer,"length"|"numberOfChannels"|"getChannelData">>;
 bucketCount?:number;
 width?:number;
 height?:number;
 maxBytes?:number;
}

async function readBoundedBody(response:Response,maxBytes:number):Promise<ArrayBuffer>{
 const declared=Number(response.headers.get("content-length")||0);
 if(Number.isFinite(declared)&&declared>maxBytes)throw new Error("Audio waveform source exceeds the preview size limit.");
 const reader=response.body?.getReader();
 if(!reader)throw new Error("Audio waveform response has no readable body.");
 const chunks:Uint8Array[]=[];let total=0;
 try{
  while(true){
   const item=await reader.read();
   if(item.done)break;
   total+=item.value.byteLength;
   if(total>maxBytes){await reader.cancel();throw new Error("Audio waveform source exceeds the preview size limit.");}
   chunks.push(item.value);
  }
 }finally{reader.releaseLock();}
 if(!total)throw new Error("Audio waveform source is empty.");
 const merged=new Uint8Array(total);let offset=0;
 for(const chunk of chunks){merged.set(chunk,offset);offset+=chunk.byteLength;}
 return merged.buffer;
}

export async function createAudioWaveformPreview(url:string,options:AudioWaveformPreviewOptions={}):Promise<string>{
 if(typeof url!=="string"||!url.trim())throw new Error("Audio waveform URL is required.");
 const fetchImpl=options.fetchImpl??fetch,decode=options.decodeAudioData;
 const maxBytes=options.maxBytes??24*1024*1024,bucketCount=options.bucketCount??240,width=options.width??720,height=options.height??48;
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>128*1024*1024)throw new Error("Audio waveform size limit is invalid.");
 if(typeof decode!=="function")throw new Error("Audio waveform decoder is unavailable.");
 const response=await fetchImpl(url,{method:"GET",credentials:"omit",headers:{accept:"audio/*,application/octet-stream"}});
 if(!response.ok)throw new Error("Audio waveform source could not be fetched.");
 const bytes=await readBoundedBody(response,maxBytes);
 const decoded=await decode(bytes.slice(0));
 const peaks=extractWaveformPeaks(decoded,bucketCount);
 return waveformSvg(peaks,width,height).replace('<svg ','<svg fill="#a78bfa" ');
}
