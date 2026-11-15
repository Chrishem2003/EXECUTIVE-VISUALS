import type { WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowPort } from "./workflow";

const port=(id:string,type:WorkflowPort["type"],required=false):WorkflowPort=>({id,label:id,type,required});
const node=(id:string,kind:WorkflowNode["kind"],label:string,inputs:WorkflowPort[],outputs:WorkflowPort[],position:{x:number;y:number},config:Record<string,unknown>={}):WorkflowNode=>({
 id,kind,label,inputs,outputs,position,config
});

/**
 * A review-first, provider-neutral audio workflow.
 * The source asset is intentionally blank: the owner must select an existing
 * private audio asset before running. The approval node is a hard ancestor of
 * transcription, so no speech gateway request occurs before human approval.
 */
export function createTranscriptionCaptionWorkflow({id,projectId=""}:{id:string;projectId?:string}):WorkflowGraph{
 if(!String(id||"").trim())throw new Error("A workflow ID is required.");
 const nodes=[
  node("source-audio","upload","Select source audio",[],[
   port("asset","asset"),port("media","media"),port("audio","audio")
  ],{x:40,y:170},{assetId:""}),
  node("human-review","approval","Approve transcription",[
   port("input","any",true)
  ],[port("result","any"),port("approved","structured-data")],{x:350,y:170}),
  node("transcribe-audio","voice.transcribe","Transcribe audio",[
   port("audio","audio",true),port("approval","any")
  ],[
   port("transcript","transcript"),port("text","text"),port("segments","structured-data"),
   port("sourceAudio","audio"),port("language","text")
  ],{x:680,y:170}),
  node("create-captions","voice.caption","Create timed captions",[
   port("segments","structured-data",true),port("sourceAudio","audio"),port("language","text")
  ],[port("subtitle","subtitle-file"),port("asset","asset")],{x:1010,y:170})
 ];
 const edges:WorkflowEdge[]=[
  {id:"source-to-review",sourceNodeId:"source-audio",sourcePortId:"audio",targetNodeId:"human-review",targetPortId:"input"},
  {id:"source-to-transcription",sourceNodeId:"source-audio",sourcePortId:"audio",targetNodeId:"transcribe-audio",targetPortId:"audio"},
  {id:"review-to-transcription",sourceNodeId:"human-review",sourcePortId:"approved",targetNodeId:"transcribe-audio",targetPortId:"approval"},
  {id:"transcription-to-captions",sourceNodeId:"transcribe-audio",sourcePortId:"segments",targetNodeId:"create-captions",targetPortId:"segments"},
  {id:"source-to-captions",sourceNodeId:"transcribe-audio",sourcePortId:"sourceAudio",targetNodeId:"create-captions",targetPortId:"sourceAudio"},
  {id:"language-to-captions",sourceNodeId:"transcribe-audio",sourcePortId:"language",targetNodeId:"create-captions",targetPortId:"language"}
 ];
 return {id,projectId,revision:1,name:"Audio transcription and captions",nodes,edges};
}
