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
   port("transcript","transcript"),port("text","text"),port("segments","structured-data"),port("words","structured-data"),
   port("sourceAudio","audio"),port("language","text")
  ],{x:680,y:170}),
  node("create-captions","voice.caption","Create timed captions",[
   port("segments","structured-data",true),port("words","structured-data"),port("sourceAudio","audio"),port("language","text")
  ],[port("subtitle","subtitle-file"),port("asset","asset")],{x:1010,y:170})
 ];
 const edges:WorkflowEdge[]=[
  {id:"source-to-review",sourceNodeId:"source-audio",sourcePortId:"audio",targetNodeId:"human-review",targetPortId:"input"},
  {id:"source-to-transcription",sourceNodeId:"source-audio",sourcePortId:"audio",targetNodeId:"transcribe-audio",targetPortId:"audio"},
  {id:"review-to-transcription",sourceNodeId:"human-review",sourcePortId:"approved",targetNodeId:"transcribe-audio",targetPortId:"approval"},
  {id:"transcription-to-captions",sourceNodeId:"transcribe-audio",sourcePortId:"segments",targetNodeId:"create-captions",targetPortId:"segments"},
  {id:"transcription-words-to-captions",sourceNodeId:"transcribe-audio",sourcePortId:"words",targetNodeId:"create-captions",targetPortId:"words"},
  {id:"source-to-captions",sourceNodeId:"transcribe-audio",sourcePortId:"sourceAudio",targetNodeId:"create-captions",targetPortId:"sourceAudio"},
  {id:"language-to-captions",sourceNodeId:"transcribe-audio",sourcePortId:"language",targetNodeId:"create-captions",targetPortId:"language"}
 ];
 return {id,projectId,revision:1,name:"Audio transcription and captions",nodes,edges};
}


/**
 * A review-first video localization workflow.
 * It extracts audio from an explicitly selected private video, transcribes it,
 * pauses for human review, translates the timed cues, then writes a WebVTT
 * sidecar asset. It never overwrites or republishes the source video.
 */
export function createVideoCaptionLocalizationWorkflow({id,projectId=""}:{id:string;projectId?:string}):WorkflowGraph{
 if(!String(id||"").trim())throw new Error("A workflow ID is required.");
 const nodes=[
  node("source-video","upload","Select source video",[],[
   port("asset","asset"),port("media","media"),port("video","video")
  ],{x:40,y:100},{assetId:""}),
  node("extract-audio","video.extract-audio","Extract source audio",[
   port("media","media",true)
  ],[port("audio","audio"),port("asset","asset")],{x:480,y:100}),
  node("approve-transcription","approval","Approve transcription",[
   port("input","any",true)
  ],[port("result","any"),port("approved","structured-data")],{x:920,y:100}),
  node("transcribe-audio","voice.transcribe","Transcribe source audio",[
   port("audio","audio",true),port("approval","any")
  ],[
   port("transcript","transcript"),port("text","text"),port("segments","structured-data"),port("words","structured-data"),
   port("sourceAudio","audio"),port("language","text")
  ],{x:40,y:360}),
  node("review-transcript","approval","Review transcript and approve translation",[
   port("input","any",true)
  ],[port("result","any"),port("approved","structured-data")],{x:480,y:360}),
  node("translate-captions","voice.translate","Translate timed captions",[
   port("segments","structured-data",true),port("approval","any"),port("language","text")
  ],[port("segments","structured-data"),port("language","text")],{x:920,y:360},{targetLanguage:""}),
  node("create-captions","voice.caption","Create translated WebVTT",[
   port("segments","structured-data",true),port("sourceAudio","audio"),port("language","text")
  ],[port("subtitle","subtitle-file"),port("asset","asset")],{x:40,y:620}),
  node("export-captions","export","Export caption sidecar",[
   port("media","media",true)
  ],[port("deliverable","asset")],{x:480,y:620})
 ];
 const edges:WorkflowEdge[]=[
  {id:"video-to-audio",sourceNodeId:"source-video",sourcePortId:"media",targetNodeId:"extract-audio",targetPortId:"media"},
  {id:"audio-to-transcription-review",sourceNodeId:"extract-audio",sourcePortId:"audio",targetNodeId:"approve-transcription",targetPortId:"input"},
  {id:"audio-to-transcription",sourceNodeId:"extract-audio",sourcePortId:"audio",targetNodeId:"transcribe-audio",targetPortId:"audio"},
  {id:"transcription-approval",sourceNodeId:"approve-transcription",sourcePortId:"approved",targetNodeId:"transcribe-audio",targetPortId:"approval"},
  {id:"transcript-to-review",sourceNodeId:"transcribe-audio",sourcePortId:"transcript",targetNodeId:"review-transcript",targetPortId:"input"},
  {id:"transcript-approval",sourceNodeId:"review-transcript",sourcePortId:"approved",targetNodeId:"translate-captions",targetPortId:"approval"},
  {id:"segments-to-translation",sourceNodeId:"transcribe-audio",sourcePortId:"segments",targetNodeId:"translate-captions",targetPortId:"segments"},
  {id:"language-to-translation",sourceNodeId:"transcribe-audio",sourcePortId:"language",targetNodeId:"translate-captions",targetPortId:"language"},
  {id:"translated-segments-to-captions",sourceNodeId:"translate-captions",sourcePortId:"segments",targetNodeId:"create-captions",targetPortId:"segments"},
  {id:"source-audio-to-captions",sourceNodeId:"transcribe-audio",sourcePortId:"sourceAudio",targetNodeId:"create-captions",targetPortId:"sourceAudio"},
  {id:"translated-language-to-captions",sourceNodeId:"translate-captions",sourcePortId:"language",targetNodeId:"create-captions",targetPortId:"language"},
  {id:"captions-to-export",sourceNodeId:"create-captions",sourcePortId:"asset",targetNodeId:"export-captions",targetPortId:"media"}
 ];
 return {id,projectId,revision:1,name:"Review-first video caption localization",nodes,edges};
}
