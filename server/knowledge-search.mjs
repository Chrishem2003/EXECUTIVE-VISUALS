export function searchProjectKnowledge(document,query,{limit=10}={}){
 const needle=String(query||"").trim().toLowerCase();
 if(!needle)throw Object.assign(new Error("Knowledge search requires a non-empty query."),{code:"KNOWLEDGE_QUERY_REQUIRED"});
 const terms=[...new Set(needle.split(/[^\\p{L}\\p{N}]+/u).filter(term=>term.length>2))];
 const sources=Array.isArray(document?.researchSources)?document.researchSources:[];
 const sourceMap=new Map(sources.map(source=>[source.id,source]));
 const records=Array.isArray(document?.knowledgeRecords)?document.knowledgeRecords:[];
 const ranked=records.map(record=>{
  const title=String(record.title||"").toLowerCase(),content=String(record.content||"").toLowerCase(),tags=(record.tags||[]).map(String);
  const haystack=[title,content,...tags].join(" ");
  const score=terms.reduce((total,term)=>total+(title.includes(term)?4:0)+(tags.some(tag=>tag.toLowerCase().includes(term))?3:0)+(content.includes(term)?1:0),0);
  return {record,score,matchedTerms:terms.filter(term=>haystack.includes(term))};
 }).filter(item=>item.score>0).sort((a,b)=>b.score-a.score||String(b.record.updatedAt||"").localeCompare(String(a.record.updatedAt||""))).slice(0,Math.max(1,Math.min(50,Number(limit)||10)));
 return {query:needle,matchedCount:ranked.length,records:ranked.map(({record,score,matchedTerms})=>({id:record.id,title:record.title,content:record.content,kind:record.kind,status:record.status,tags:record.tags||[],score,matchedTerms,evidence:(record.sourceIds||[]).map(id=>sourceMap.get(id)).filter(Boolean).map(source=>({id:source.id,title:source.title,url:source.url,sourceType:source.sourceType,author:source.author,publishedAt:source.publishedAt,rights:source.rights}))}))};
}
