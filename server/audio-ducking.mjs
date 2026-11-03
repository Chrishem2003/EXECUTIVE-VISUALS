const clamp=(value,min,max,fallback)=>Number.isFinite(Number(value))?Math.max(min,Math.min(max,Number(value))):fallback;
export function normalizeDuckingSettings(metadata={}){
 const input=metadata&&typeof metadata==="object"?metadata:{};
 return {thresholdDb:clamp(input.duckingThresholdDb,-60,-6,-24),ratio:clamp(input.duckingRatio,1,20,8),attackMs:clamp(input.duckingAttackMs,1,200,20),releaseMs:clamp(input.duckingReleaseMs,20,2000,300)};
}
export function buildAudioDuckingGraph(audioItems=[]){
 const items=Array.isArray(audioItems)?audioItems:[];
 const voices=items.filter(item=>item?.role==="voice"&&typeof item.label==="string");
 const music=items.filter(item=>item?.role==="music"&&item?.duckingEnabled===true&&typeof item.label==="string");
 const filters=[],outputLabels=items.filter(item=>typeof item?.label==="string").map(item=>item.label);
 if(!voices.length||!music.length)return{filters,outputLabels,duckedClips:0};
 const voiceSidechainLabels=[];
 for(let index=0;index<voices.length;index++){
  const voice=voices[index],mainLabel="voice-main-"+index,sideLabel="voice-sidechain-"+index;
  filters.push("["+voice.label+"]asplit=2["+mainLabel+"]["+sideLabel+"]");
  const outputIndex=outputLabels.indexOf(voice.label);if(outputIndex>=0)outputLabels[outputIndex]=mainLabel;
  voiceSidechainLabels.push("["+sideLabel+"]");
 }
 let sidechainLabel;
 if(voiceSidechainLabels.length===1)sidechainLabel=voiceSidechainLabels[0].slice(1,-1);
 else{sidechainLabel="ducking-voice-bus";filters.push(voiceSidechainLabels.join("")+"amix=inputs="+voiceSidechainLabels.length+":duration=longest:normalize=0["+sidechainLabel+"]");}
 let duckedClips=0;
 for(let index=0;index<music.length;index++){
  const item=music[index],settings=normalizeDuckingSettings(item.settings),output="ducked-music-"+index;
  filters.push("["+item.label+"]["+sidechainLabel+"]sidechaincompress=threshold="+Math.pow(10,settings.thresholdDb/20).toFixed(6)+":ratio="+settings.ratio.toFixed(2)+":attack="+settings.attackMs.toFixed(1)+":release="+settings.releaseMs.toFixed(1)+"["+output+"]");
  const outputIndex=outputLabels.indexOf(item.label);if(outputIndex>=0)outputLabels[outputIndex]=output;
  duckedClips++;
 }
 return{filters,outputLabels,duckedClips};
}
