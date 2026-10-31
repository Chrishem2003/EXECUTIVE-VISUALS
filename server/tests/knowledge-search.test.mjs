import test from "node:test";
import assert from "node:assert/strict";
import { searchProjectKnowledge } from "../knowledge-search.mjs";

test("project knowledge search ranks findings and returns their source provenance",()=>{
 const document={researchSources:[{id:"s1",title:"Wetland monitoring report",url:"https://example.org/wetlands",sourceType:"Official report",author:"Agency",publishedAt:"2026-01-01",rights:"Public"}],knowledgeRecords:[
  {id:"k1",title:"Wetland vegetation change",content:"Satellite evidence indicates vegetation loss across the wetland boundary.",tags:["wetland","satellite"],kind:"Finding",status:"Verified",sourceIds:["s1"],updatedAt:"2026-10-31"},
  {id:"k2",title:"Podcast intro",content:"An opening script for the next episode.",tags:["media"],kind:"Draft",status:"Draft",sourceIds:[]}
 ]};
 const result=searchProjectKnowledge(document,"wetland vegetation");
 assert.equal(result.matchedCount,1);
 assert.equal(result.records[0].id,"k1");
 assert.equal(result.records[0].evidence[0].url,"https://example.org/wetlands");
 assert.deepEqual(result.records[0].matchedTerms,["wetland","vegetation"]);
});

test("project knowledge search rejects blank queries and clamps result limits",()=>{
 assert.throws(()=>searchProjectKnowledge({knowledgeRecords:[]},"   "),error=>error.code==="KNOWLEDGE_QUERY_REQUIRED");
 const records=Array.from({length:60},(_,i)=>({id:String(i),title:"Wetland "+i,content:"Wetland change",tags:[],sourceIds:[]}));
 assert.equal(searchProjectKnowledge({knowledgeRecords:records},"wetland",{limit:100}).matchedCount,50);
});
