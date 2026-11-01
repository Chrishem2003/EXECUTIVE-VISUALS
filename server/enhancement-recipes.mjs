import {buildMediaOperationArgs} from "./media.mjs";
import {validateWorkflowGraph} from "./workflow-validation.mjs";

const VIDEO_STEPS=new Set(["media.denoise","media.color","media.resize","media.interpolate","media.upscale"]);
const AUDIO_STEPS=new Set(["media.audio-clean"]);
const MAX_STEPS=12;
const PARAMETER_KEYS={
  "media.denoise":["luma","chroma"],"media.color":["brightness","contrast","saturation"],
  "media.resize":["width","height","fit"],"media.interpolate":["fps"],
  "media.upscale":["width","height","fit","algorithm","sharpness"],
  "media.audio-clean":["noiseFloor","targetLufs"]
};

export function planEnhancementRecipe({name="Enhancement recipe",sourceAsset,steps=[]}={}) {
  if(!sourceAsset||typeof sourceAsset.id!=="string"||typeof sourceAsset.media_type!=="string")
    throw Object.assign(new Error("A source asset with an ID and media type is required."),{code:"RECIPE_SOURCE_REQUIRED"});
  if(!Array.isArray(steps)||steps.length===0||steps.length>MAX_STEPS)
    throw Object.assign(new Error("A recipe must contain between 1 and 12 steps."),{code:"RECIPE_STEP_LIMIT"});
  const mediaType=sourceAsset.media_type;
  let currentType=mediaType;
  const planned=steps.map((step,index)=>{
    if(!step||typeof step!=="object"||Array.isArray(step))throw Object.assign(new Error("Each recipe step must be an object."),{code:"RECIPE_STEP_INVALID",step:index});
    const operation=String(step.operation||"");
    const rawParameters=step.parameters??{};
    if(!rawParameters||typeof rawParameters!=="object"||Array.isArray(rawParameters))throw Object.assign(new Error("Recipe step parameters must be an object."),{code:"RECIPE_PARAMETERS_INVALID",step:index});
    const parameters=Object.fromEntries(Object.entries(rawParameters).filter(([key])=>(PARAMETER_KEYS[operation]||[]).includes(key)));
    if(VIDEO_STEPS.has(operation)) {
      if(!currentType.startsWith("video/"))throw Object.assign(new Error(operation+" requires a video source."),{code:"RECIPE_MEDIA_TYPE_MISMATCH",step:index});
      buildMediaOperationArgs({jobType:operation,input:parameters,sourcePath:"/recipe/source.mp4",outputPath:"/recipe/output.mp4"});
    } else if(AUDIO_STEPS.has(operation)) {
      if(!currentType.startsWith("audio/"))throw Object.assign(new Error(operation+" requires an audio source."),{code:"RECIPE_MEDIA_TYPE_MISMATCH",step:index});
      buildMediaOperationArgs({jobType:operation,input:parameters,sourcePath:"/recipe/source.wav",outputPath:"/recipe/output.wav"});
      currentType="audio/wav";
    } else {
      throw Object.assign(new Error("Unsupported recipe operation: "+operation),{code:"RECIPE_OPERATION_UNSUPPORTED",step:index});
    }
    return {
      index,
      operation,
      parameters,
      engine:"ffmpeg",
      method:operation==="media.upscale"||operation==="media.resize"?"deterministic-resampling":
        operation==="media.interpolate"?"optical-flow-frame-interpolation":
        operation==="media.denoise"?"classical-video-denoising":
        operation==="media.color"?"deterministic-color-adjustment":"classical-audio-filtering",
      requiresApproval:true
    };
  });
  return {
    schemaVersion:1,
    name:String(name).trim().slice(0,100)||"Enhancement recipe",
    source:{assetId:sourceAsset.id,mediaType,sha256:typeof sourceAsset.sha256==="string"?sourceAsset.sha256:null},
    steps:planned,
    execution:{mode:"dry-run",requiresApproval:true,estimatedCost:null,estimatedDuration:null},
    warnings:["This plan does not execute media processing.","Video upscaling in this recipe uses deterministic resampling, not neural super-resolution."]
  };
}

/**
 * Compile a validated dry-run recipe into the platform's existing workflow graph.
 * The graph pauses at a human approval node before any media operation can run.
 * Compilation never queues or executes work.
 */
export function compileEnhancementRecipeToWorkflow(options={}) {
  const plan=planEnhancementRecipe(options);
  const nodes=[
    {id:"recipe-source",kind:"upload",label:"Recipe source",inputs:[],outputs:[{id:"media",type:"media"}],config:{assetId:plan.source.assetId}},
    {id:"recipe-approval",kind:"approval",label:"Approve enhancement recipe",inputs:[{id:"media",type:"media",required:true}],outputs:[{id:"media",type:"media"}],config:{approvalScope:"enhancement-recipe",recipeName:plan.name}}
  ];
  const edges=[
    {id:"recipe-source-to-approval",sourceNodeId:"recipe-source",sourcePortId:"media",targetNodeId:"recipe-approval",targetPortId:"media"}
  ];
  let previousNode="recipe-approval";
  for(const step of plan.steps) {
    const nodeId="recipe-step-"+(step.index+1);
    nodes.push({
      id:nodeId,kind:step.operation,label:step.operation.replace(/^media\\./,"").replaceAll("-"," "),
      inputs:[{id:"media",type:"media",required:true}],
      outputs:[{id:"media",type:"media"}],
      config:{...step.parameters}
    });
    edges.push({
      id:"recipe-edge-"+(step.index+1),
      sourceNodeId:previousNode,sourcePortId:"media",
      targetNodeId:nodeId,targetPortId:"media"
    });
    previousNode=nodeId;
  }
  const graph={id:"enhancement-recipe",projectId:"",revision:1,nodes,edges};
  const validation=validateWorkflowGraph(graph);
  if(!validation.valid)throw Object.assign(new Error("Compiled enhancement recipe failed workflow validation."),{code:"RECIPE_WORKFLOW_INVALID",details:validation.issues});
  return {
    schemaVersion:1,
    plan,
    graph,
    validation:{valid:true,executionOrder:validation.executionOrder},
    execution:{mode:"approval-gated-workflow",queued:false,requiresApproval:true}
  };
}
