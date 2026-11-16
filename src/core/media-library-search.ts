export type MediaSearchAsset={id:string;name:string;mediaType:string;projectId?:string|null;createdAt?:string;metadata?:Record<string,unknown>};
export type MediaSearchHit={asset:MediaSearchAsset;score:number;matchedTerms:string[];field:"name"|"transcript"|"metadata";snippet:string;timeSeconds?:number};
type Field={field:MediaSearchHit["field"];text:string;timeSeconds?:number};
const TEXT_KEYS=new Set(["title","name","description","summary","transcript","transcriptText","text","caption","captions","tags","keywords","speaker","scene","sceneDescription","visualDescription","notes","location","camera","subject","objects","labels","category","filename","originalName"]);
const norm=(s:string)=>s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
function collect(value:unknown,out:Field[],depth=0,key=""){
 if(depth>5||out.length>=5200||value==null)return;
 if(typeof value==="string"){if(TEXT_KEYS.has(key)||/(tag|keyword|object|subject|label)/i.test(key)){const text=value.replace(/\s+/g," ").trim().slice(0,1800);if(text)out.push({field:"metadata",text});}return;}
 if(Array.isArray(value)){for(const item of value.slice(0,100))collect(item,out,depth+1,key);return;}
 if(typeof value!=="object")return;
 for(const [k,v] of Object.entries(value as Record<string,unknown>)){
  if(["segments","words","transcriptSegments","transcriptWords","captions"].includes(k)&&Array.isArray(v)){
   for(const entry of v.slice(0,5000)){if(out.length>=5200)break;if(!entry||typeof entry!=="object")continue;const row=entry as Record<string,unknown>;const text=String(row.text??row.word??row.transcript??"").replace(/\s+/g," ").trim().slice(0,500);const time=Number(row.start??row.startSeconds);if(text)out.push({field:"transcript",text,...(Number.isFinite(time)&&time>=0?{timeSeconds:time}:{})});}
  }else if(TEXT_KEYS.has(k)||/(tag|keyword|object|subject|label)/i.test(k)||["transcript","probe","analysis","signals","metadata"].includes(k))collect(v,out,depth+1,k);
 }
}
function scoreField(field:Field,terms:string[],phrase:string){const text=norm(field.text);let score=phrase&&text.includes(phrase)?(field.field==="name"?16:field.field==="transcript"?13:10):0;for(const term of terms)if(text.includes(term))score+=field.field==="name"?5:field.field==="transcript"?6:3;return score;}
function snippet(text:string,terms:string[]){const n=norm(text);let at=-1;for(const term of terms){const i=n.indexOf(term);if(i>=0&&(at<0||i<at))at=i;}if(at<0)return text.slice(0,180);const start=Math.max(0,at-65),end=Math.min(text.length,at+115);return (start?"…":"")+text.slice(start,end)+(end<text.length?"…":"");}
export function rankMediaAssets<T extends MediaSearchAsset>(assets:readonly T[],query:string,options:{projectId?:string|null;mediaType?:string;limit?:number}={}):MediaSearchHit[]{
 const raw=String(query??"").trim().slice(0,200),phrase=norm(raw),terms=[...new Set(phrase.split(/\s+/).filter(x=>x.length>=2))];if(!terms.length)return [];
 const limit=Math.max(1,Math.min(50,Math.floor(Number(options.limit)||20))),hits:MediaSearchHit[]=[];
 for(const asset of assets){if(options.projectId&&asset.projectId!==options.projectId)continue;if(options.mediaType&&!(asset.mediaType===options.mediaType||asset.mediaType.startsWith(options.mediaType)))continue;
  const fields:Field[]=[{field:"name",text:String(asset.name||"")}];collect(asset.metadata||{},fields);
  const matched=new Set<string>();let best:Field|undefined,bestScore=-1,total=0;
  for(const field of fields){const n=norm(field.text);if(!n)continue;const s=scoreField(field,terms,phrase);if(s>0){total+=s;for(const term of terms)if(n.includes(term))matched.add(term);if(s>bestScore){best=field;bestScore=s;}}}
  if(!best||matched.size!==terms.length)continue;
  hits.push({asset,score:total,matchedTerms:[...matched],field:best.field,snippet:snippet(best.text,terms),...(best.timeSeconds!==undefined?{timeSeconds:best.timeSeconds}:{})});
 }
 return hits.sort((a,b)=>b.score-a.score||String(b.asset.createdAt||"").localeCompare(String(a.asset.createdAt||""))||a.asset.name.localeCompare(b.asset.name)).slice(0,limit);
}
