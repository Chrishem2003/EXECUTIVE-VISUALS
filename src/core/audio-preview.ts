export interface AudioPreviewTrackInput {
 id:string;
 media:HTMLMediaElement;
 gainDb?:number;
 muted?:boolean;
 solo?:boolean;
}

type ConnectedTrack={media:HTMLMediaElement;source:MediaElementAudioSourceNode;gain:GainNode;gainDb:number;muted:boolean;solo:boolean};

export function decibelsToGain(value:number,minDb=-60,maxDb=24):number{
 const db=Number.isFinite(value)?Math.max(minDb,Math.min(maxDb,value)):0;
 return Math.pow(10,db/20);
}

export function extractWaveformPeaks(buffer:Pick<AudioBuffer,"length"|"numberOfChannels"|"getChannelData">,bucketCount=480):number[]{
 if(!Number.isSafeInteger(bucketCount)||bucketCount<1||bucketCount>8192)throw new Error("Waveform bucket count must be an integer from 1 to 8192.");
 if(!Number.isSafeInteger(buffer.length)||buffer.length<1||!Number.isSafeInteger(buffer.numberOfChannels)||buffer.numberOfChannels<1)throw new Error("Waveform audio buffer is empty.");
 const buckets=Math.min(bucketCount,buffer.length),peaks:number[]=new Array(buckets).fill(0);
 for(let channel=0;channel<buffer.numberOfChannels;channel++){
  const samples=buffer.getChannelData(channel);
  for(let bucket=0;bucket<buckets;bucket++){
   const start=Math.floor(bucket*buffer.length/buckets),end=Math.max(start+1,Math.floor((bucket+1)*buffer.length/buckets));
   let peak=0;
   for(let index=start;index<end;index++){const sample=samples[index];if(Number.isFinite(sample))peak=Math.max(peak,Math.abs(sample));}
   peaks[bucket]=Math.max(peaks[bucket],Math.min(1,peak));
  }
 }
 return peaks;
}

export function waveformSvg(peaks:readonly number[],width=480,height=36):string{
 if(!Number.isFinite(width)||!Number.isFinite(height)||width<1||height<1||width>4096||height>512)throw new Error("Waveform dimensions are outside supported bounds.");
 if(!peaks.length)return "";
 const barWidth=width/peaks.length,mid=height/2;
 const bars=peaks.map((peak,index)=>{
  const value=Number.isFinite(peak)?Math.max(0,Math.min(1,peak)):0;
  const barHeight=Math.max(1,value*(height-2));
  return '<rect x="'+(index*barWidth).toFixed(2)+'" y="'+(mid-barHeight/2).toFixed(2)+'" width="'+Math.max(.5,barWidth*.72).toFixed(2)+'" height="'+barHeight.toFixed(2)+'" rx="0.5"/>';
 }).join("");
 return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+width+' '+height+'" preserveAspectRatio="none" aria-hidden="true">'+bars+'</svg>';
}

export class AudioPreviewEngine{
 readonly context:AudioContext;
 private readonly master:GainNode;
 private readonly limiter:DynamicsCompressorNode;
 private readonly connected=new Map<string,ConnectedTrack>();
 private masterVolume=0.85;
 private masterMuted=false;
 constructor(context:AudioContext){
  this.context=context;
  this.master=context.createGain();
  this.limiter=context.createDynamicsCompressor();
  this.limiter.threshold.setValueAtTime(-3,context.currentTime);
  this.limiter.knee.setValueAtTime(6,context.currentTime);
  this.limiter.ratio.setValueAtTime(12,context.currentTime);
  this.limiter.attack.setValueAtTime(0.003,context.currentTime);
  this.limiter.release.setValueAtTime(0.18,context.currentTime);
  this.master.connect(this.limiter);
  this.limiter.connect(context.destination);
  this.applyMaster();
 }
 static async create(factory:()=>AudioContext=()=>new AudioContext()):Promise<AudioPreviewEngine>{
  const engine=new AudioPreviewEngine(factory());
  await engine.resume();
  return engine;
 }
 async resume():Promise<void>{if(this.context.state!=="running")await this.context.resume();}
 sync(tracks:readonly AudioPreviewTrackInput[]):void{
  const active=new Set(tracks.map(track=>track.id));
  for(const [id,entry] of this.connected){if(!active.has(id)){entry.media.pause();entry.source.disconnect();entry.gain.disconnect();this.connected.delete(id);}}
  for(const track of tracks){
   let entry=this.connected.get(track.id);
   if(entry&&entry.media!==track.media){entry.source.disconnect();entry.gain.disconnect();this.connected.delete(track.id);entry=undefined;}
   if(!entry){
    const source=this.context.createMediaElementSource(track.media),gain=this.context.createGain();
    source.connect(gain);gain.connect(this.master);
    entry={media:track.media,source,gain,gainDb:track.gainDb??0,muted:false,solo:false};
    this.connected.set(track.id,entry);
   }
   entry.muted=!!track.muted;entry.solo=!!track.solo;entry.gainDb=track.gainDb??0;
   const target=decibelsToGain(entry.gainDb);
   entry.gain.gain.setTargetAtTime(target,this.context.currentTime,0.015);
  }
  this.applyTrackStates();
 }
 setTrackGain(id:string,gainDb:number):void{
  const entry=this.connected.get(id);if(!entry)return;
  entry.gainDb=gainDb;
  this.applyTrackStates();
 }
 setMasterVolume(value:number):void{this.masterVolume=Math.max(0,Math.min(1,Number.isFinite(value)?value:0));this.applyMaster();}
 setMasterMuted(muted:boolean):void{this.masterMuted=!!muted;this.applyMaster();}
 get isMasterMuted():boolean{return this.masterMuted;}
 get masterVolumeLevel():number{return this.masterVolume;}
 private applyMaster():void{this.master.gain.setTargetAtTime(this.masterMuted?0:this.masterVolume,this.context.currentTime,0.015);}
 private applyTrackStates():void{
  const hasSolo=[...this.connected.values()].some(entry=>entry.solo);
  for(const entry of this.connected.values()){
   const suppressed=entry.muted||(hasSolo&&!entry.solo);
   entry.gain.gain.setTargetAtTime(suppressed?0:decibelsToGain(entry.gainDb),this.context.currentTime,0.015);
  }
 }
 dispose():void{
  for(const entry of this.connected.values()){entry.media.pause();entry.source.disconnect();entry.gain.disconnect();}
  this.connected.clear();this.master.disconnect();this.limiter.disconnect();
  void this.context.close();
 }
}
