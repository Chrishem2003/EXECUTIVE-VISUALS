import type { MediaPortType, WorkflowEdge, WorkflowNode, WorkflowNodeKind, WorkflowPort } from "./workflow";

export const port=(id:string,type:MediaPortType,required=false,multiple=false):WorkflowPort=>({id,label:id,type,required,multiple});
export const palette:Record<string,{kind:WorkflowNodeKind;label:string;inputs:WorkflowPort[];outputs:WorkflowPort[]}>={
 knowledge:{kind:"knowledge.search",label:"Search Project Knowledge",inputs:[port("query","text",true)],outputs:[port("document","document"),port("records","structured-data"),port("sources","document",false,true),port("text","text")]},
 text:{kind:"text",label:"Text / Prompt",inputs:[],outputs:[port("text","text")]},
 upload:{kind:"upload",label:"Use Uploaded Asset",inputs:[],outputs:[port("asset","asset"),port("media","media")]},
 reference:{kind:"reference",label:"Reference Asset",inputs:[],outputs:[port("asset","asset"),port("media","media")]},
 llm:{kind:"llm.prompt",label:"AI Text Processor",inputs:[port("prompt","text",true)],outputs:[port("text","text")]},
 image:{kind:"image.generate",label:"Image Generation",inputs:[port("prompt","text",true),port("reference","image")],outputs:[port("image","image")]},
 video:{kind:"video.generate",label:"Video Generation",inputs:[port("prompt","text",true),port("start-frame","start-frame"),port("reference","video",false,true)],outputs:[port("video","video")]},
 voice:{kind:"voice.generate",label:"Voice Generation",inputs:[port("script","text",true)],outputs:[port("audio","audio")]},
 transcribe:{kind:"voice.transcribe",label:"Audio Transcription",inputs:[port("audio","audio",true),port("approval","any")],outputs:[port("transcript","transcript"),port("text","text"),port("segments","structured-data"),port("sourceAudio","audio"),port("language","text")]},
 translate:{kind:"voice.translate",label:"Translate Captions",inputs:[port("segments","structured-data",true),port("approval","any"),port("language","text")],outputs:[port("segments","structured-data"),port("language","text")]},
 captions:{kind:"voice.caption",label:"Create Timed Captions",inputs:[port("segments","structured-data",true),port("sourceAudio","audio"),port("language","text")],outputs:[port("subtitle","subtitle-file"),port("asset","asset")]},
 frame:{kind:"utility.frame-extract",label:"Extract Video Frame",inputs:[port("media","media",true)],outputs:[port("image","image")]},
 audio:{kind:"video.extract-audio",label:"Extract Audio",inputs:[port("media","media",true)],outputs:[port("audio","audio")]},
 transcode:{kind:"utility.convert",label:"Convert / Compress",inputs:[port("asset","asset",true)],outputs:[port("asset","asset")]},
 timeline:{kind:"timeline",label:"Render Saved Timeline",inputs:[],outputs:[port("video","video")]},
 upscale:{kind:"media.upscale",label:"Image Upscale",inputs:[port("image","image",true)],outputs:[port("image","image")]},
 speed:{kind:"media.speed",label:"Speed Change",inputs:[port("media","media",true)],outputs:[port("video","video")]},
 fade:{kind:"media.fade",label:"Fade In / Out",inputs:[port("media","media",true)],outputs:[port("video","video")]},
 motion:{kind:"media.motion",label:"Still to Camera Move",inputs:[port("image","image",true)],outputs:[port("video","video")]},
 silence:{kind:"media.silence-trim",label:"Trim Silence",inputs:[port("audio","media",true)],outputs:[port("audio","audio")]},
 mux:{kind:"media.mux",label:"Add / Replace Audio",inputs:[port("video","media",true),port("audio","media",true)],outputs:[port("video","video")]},
 brand:{kind:"media.brand",label:"Logo Overlay",inputs:[port("video","media",true),port("logo","image",true)],outputs:[port("video","video")]},
 stabilize:{kind:"media.stabilize",label:"Stabilize (gateway)",inputs:[port("media","media",true),port("approval","any")],outputs:[port("video","video")]},
 cutout:{kind:"image.remove-background",label:"Remove Background (gateway)",inputs:[port("image","image",true),port("approval","any")],outputs:[port("image","image")]},
 extend:{kind:"video.extend",label:"Extend Clip (gateway)",inputs:[port("media","media",true),port("prompt","text"),port("approval","any")],outputs:[port("video","video")]},
 restyle:{kind:"video.restyle",label:"Restyle Footage (gateway)",inputs:[port("media","media",true),port("prompt","text",true),port("approval","any")],outputs:[port("video","video")]},
 eraser:{kind:"media.remove-object",label:"Remove Object (gateway)",inputs:[port("media","media",true),port("prompt","text",true),port("approval","any")],outputs:[port("video","video")]},
 presenter:{kind:"avatar.generate",label:"Presenter Video (consent-gated)",inputs:[port("script","text",true),port("approval","any")],outputs:[port("video","video")]},
 lipsync:{kind:"voice.lipsync",label:"Lip-Sync (consent-gated)",inputs:[port("video","media",true),port("audio","media",true),port("approval","any")],outputs:[port("video","video")]},
 approval:{kind:"approval",label:"Human Approval",inputs:[port("input","any",true)],outputs:[port("result","any"),port("approved","structured-data")]},
 quality:{kind:"quality-check",label:"Quality Gate",inputs:[port("media","media",true)],outputs:[port("report","structured-data")]},
 export:{kind:"export",label:"Export Deliverable",inputs:[port("media","media",true)],outputs:[port("deliverable","asset")]},
 merge:{kind:"merge",label:"Merge Branches",inputs:[port("items","any",true,true)],outputs:[port("result","any")]},
 batch:{kind:"batch",label:"Batch Inputs",inputs:[port("items","asset",true,true)],outputs:[port("results","asset",false,true)]}
};

/** A starter graph built only from palette nodes. Edges are [fromNode, fromPort, toNode, toPort]. */
export interface WorkflowTemplate { label: string; description: string; nodes: Array<[string, string]>; edges: Array<[string, string, string, string]> }

export const templates: Record<string, WorkflowTemplate> = {
  narrated: {
    label: "Narrate a video",
    description: "Approve a script, speak it, lay the voice over your video.",
    nodes: [["script", "text"], ["gate", "approval"], ["voice", "voice"], ["clip", "upload"], ["mix", "mux"], ["out", "export"]],
    edges: [["script", "text", "gate", "input"], ["gate", "result", "voice", "script"], ["clip", "media", "mix", "video"], ["voice", "audio", "mix", "audio"], ["mix", "video", "out", "media"]]
  },
  branded: {
    label: "Fade and brand a clip",
    description: "Fade a video in and out, then add your logo and export.",
    nodes: [["clip", "upload"], ["fade", "fade"], ["logo", "upload"], ["mark", "brand"], ["out", "export"]],
    edges: [["clip", "media", "fade", "media"], ["fade", "video", "mark", "video"], ["logo", "asset", "mark", "logo"], ["mark", "video", "out", "media"]]
  },
  hero: {
    label: "Still to hero shot",
    description: "Turn a still image into a camera-move clip with fades.",
    nodes: [["still", "upload"], ["move", "motion"], ["fade", "fade"], ["out", "export"]],
    edges: [["still", "asset", "move", "image"], ["move", "video", "fade", "media"], ["fade", "video", "out", "media"]]
  }
};

/** Build fresh nodes and edges for a template, placed below `startY`. Node configs start empty. */
export function instantiateTemplate(key: string, startY = 30, newId: () => string = () => crypto.randomUUID()): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const template = templates[key];
  if (!template) throw new Error(`Unknown workflow template: ${key}`);
  const ids = new Map<string, string>();
  const nodes = template.nodes.map(([local, def], index) => {
    const spec = palette[def];
    if (!spec) throw new Error(`Template ${key} uses an unknown palette node: ${def}`);
    const id = newId();
    ids.set(local, id);
    return { id, kind: spec.kind, label: spec.label, inputs: spec.inputs.map(x => ({ ...x })), outputs: spec.outputs.map(x => ({ ...x })), config: {}, position: { x: 30 + (index % 3) * 300, y: startY + Math.floor(index / 3) * 210 } } as WorkflowNode;
  });
  const edges = template.edges.map(([from, fromPort, to, toPort]) => ({ id: newId(), sourceNodeId: ids.get(from)!, sourcePortId: fromPort, targetNodeId: ids.get(to)!, targetPortId: toPort }) as WorkflowEdge);
  return { nodes, edges };
}
