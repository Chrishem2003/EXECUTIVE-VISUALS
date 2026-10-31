/**
 * Provider-neutral capability atlas.
 *
 * This is a product contract and discovery registry, not a claim that every
 * capability has an executable provider adapter. Only entries with tested
 * evidence and a configured adapter may be run.
 */
export type CapabilityDomain =
  | "direction" | "preproduction" | "identity" | "image" | "video"
  | "cinema" | "editing" | "audio" | "localization" | "enhancement"
  | "workflow" | "agent" | "campaign" | "design" | "assets"
  | "collaboration" | "integration" | "operations" | "quality" | "spatial" | "production" | "capture";

export type EvidenceStatus =
  | "publicly-documented" | "publicly-visible" | "inferred" | "unverified";

export type ExecutionMode =
  | "sync" | "async" | "streaming" | "interactive" | "local";

export type Readiness =
  | "specification-only" | "adapter-required" | "credentials-required"
  | "tested" | "disabled" | "unsupported";

export type SemanticMediaRole =
  | "prompt" | "script" | "document" | "image" | "video" | "audio"
  | "mask" | "identity-reference" | "style-reference" | "product-reference"
  | "start-frame" | "end-frame" | "keyframe" | "motion-reference"
  | "transcript" | "subtitle" | "voice-profile" | "brand-kit"
  | "glossary" | "timeline" | "structured-data" | "asset" | "3d-scene" | "mesh" | "camera-data" | "timecode" | "proxy" | "timeline-package";

export interface CapabilityPort {
  id: string;
  role: SemanticMediaRole;
  required?: boolean;
  multiple?: boolean;
  description: string;
}

export interface CapabilityDefinition {
  id: string;
  version: number;
  domain: CapabilityDomain;
  label: string;
  evidence: EvidenceStatus;
  readiness: Readiness;
  execution: ExecutionMode[];
  inputs: CapabilityPort[];
  outputs: CapabilityPort[];
  approvals?: Array<"paid-execution" | "likeness" | "voice" | "publishing" | "external-action" | "destructive-action" | "source-rights">;
  notes?: string;
}

const p = (id: string, role: SemanticMediaRole, description: string, required = true, multiple = false): CapabilityPort =>
  ({ id, role, description, required, multiple });

const spec = (
  id: string, domain: CapabilityDomain, label: string,
  inputs: CapabilityPort[], outputs: CapabilityPort[],
  options: Partial<Omit<CapabilityDefinition, "id" | "version" | "domain" | "label" | "inputs" | "outputs">> = {}
): CapabilityDefinition => ({
  id, version: 1, domain, label, evidence: "inferred",
  readiness: "specification-only", execution: ["async"], inputs, outputs, ...options
});

/** Stable, provider-neutral capability definitions used by planners and validators. */
export const CAPABILITY_ATLAS: readonly CapabilityDefinition[] = [
  spec("direction.brief-analyze", "direction", "Analyze creative brief",
    [p("brief","document","Brief, prompt or task description"),p("references","asset","Optional supporting references",false,true)],
    [p("creative-brief","structured-data","Normalized objective, audience and constraints")], {execution:["sync"]}),
  spec("direction.plan", "direction", "Build creative production plan",
    [p("brief","structured-data","Approved creative brief"),p("brand","brand-kit","Optional brand direction",false)],
    [p("plan","structured-data","Editable plan and dependency graph")], {execution:["sync"]}),
  spec("direction.critique", "direction", "Creative critique and continuity review",
    [p("assets","asset","Candidate outputs",true,true),p("brief","structured-data","Original creative intent")],
    [p("review","structured-data","Findings, scores and revision suggestions")], {execution:["sync"]}),
  spec("story.research", "preproduction", "Research story topic",
    [p("topic","prompt","Research topic"),p("sources","document","Optional source documents",false,true)],
    [p("research-pack","document","Source-backed research and claims")], {execution:["async"]}),
  spec("story.script", "preproduction", "Write and revise script",
    [p("brief","structured-data","Audience, goal, duration and tone"),p("research","document","Optional research pack",false)],
    [p("script","script","Versioned script with timing")], {execution:["sync"]}),
  spec("story.storyboard", "preproduction", "Create storyboard",
    [p("script","script","Approved script"),p("identity","identity-reference","Character references",false,true),p("style","style-reference","Style references",false,true)],
    [p("storyboard","structured-data","Ordered storyboard frames")], {execution:["sync"]}),
  spec("story.shot-plan", "preproduction", "Create shot plan",
    [p("storyboard","structured-data","Storyboard"),p("direction","structured-data","Global production direction")],
    [p("shot-plan","structured-data","Shots, camera, lighting and duration")], {execution:["sync"]}),
  spec("identity.profile", "identity", "Create reusable identity profile",
    [p("references","identity-reference","Authorized identity references",true,true),p("consent","structured-data","Purpose-scoped consent grant")],
    [p("identity-profile","structured-data","Identity metadata and lineage")], {approvals:["likeness"]}),
  spec("identity.train", "identity", "Train provider-scoped identity",
    [p("references","identity-reference","Authorized source media",true,true),p("consent","structured-data","Verified consent grant")],
    [p("provider-identity","structured-data","Provider-scoped identity handle")], {approvals:["paid-execution","likeness"]}),
  spec("image.generate", "image", "Generate image",
    [p("prompt","prompt","Generation prompt"),p("references","image","Typed references",false,true),p("brand","brand-kit","Optional brand kit",false)],
    [p("image","image","Generated image")], {approvals:["paid-execution"]}),
  spec("image.edit", "image", "Edit image with instruction and mask",
    [p("source","image","Source image"),p("prompt","prompt","Edit instruction"),p("mask","mask","Optional region mask",false)],
    [p("image","image","Edited image")], {approvals:["paid-execution"]}),
  spec("image.composite", "image", "Composite product into generated scene",
    [p("product","product-reference","Product image"),p("scene","image","Background or generated scene"),p("brand","brand-kit","Brand constraints",false)],
    [p("image","image","Composited image")], {approvals:["paid-execution","source-rights"]}),
  spec("image.restore", "image", "Restore and repair image",
    [p("source","image","Original image")],[p("restored","image","Restored image")]),
  spec("image.upscale", "image", "Upscale image",
    [p("source","image","Source image"),p("settings","structured-data","Target resolution and model settings")],
    [p("image","image","Upscaled image")]),
  spec("video.generate", "video", "Generate video from prompt",
    [p("prompt","prompt","Motion and scene prompt"),p("references","asset","Typed references",false,true),p("settings","structured-data","Model-specific settings")],
    [p("video","video","Generated video")], {approvals:["paid-execution"]}),
  spec("video.image-to-video", "video", "Animate image",
    [p("image","start-frame","Starting image"),p("motion","prompt","Motion prompt"),p("end","end-frame","Optional end frame",false)],
    [p("video","video","Generated video")], {approvals:["paid-execution"]}),
  spec("video.extend", "video", "Extend video",
    [p("video","video","Source video"),p("prompt","prompt","Continuation direction")],
    [p("video","video","Extended video")], {approvals:["paid-execution"]}),
  spec("video.regional-edit", "video", "Edit selected video region",
    [p("video","video","Source video"),p("mask","mask","Spatial or temporal mask"),p("prompt","prompt","Edit instruction")],
    [p("video","video","Edited video")], {approvals:["paid-execution"]}),
  spec("cinema.shot-direct", "cinema", "Direct a cinematic shot",
    [p("shot","structured-data","Shot description and continuity constraints"),p("camera","structured-data","Camera and lens setup"),p("lighting","structured-data","Lighting setup")],
    [p("video","video","Directed shot")], {approvals:["paid-execution"]}),
  spec("editing.timeline-assemble", "editing", "Assemble multitrack timeline",
    [p("clips","asset","Ordered media clips",true,true),p("audio","audio","Audio tracks",false,true),p("captions","subtitle","Caption tracks",false,true)],
    [p("timeline","timeline","Editable timeline")], {execution:["local","sync"]}),
  spec("editing.motion-graphics", "editing", "Create motion graphics",
    [p("design","structured-data","Layout and typography specification"),p("assets","asset","Media and brand assets",false,true)],
    [p("video","video","Motion graphics composition")], {execution:["local","async"]}),
  spec("audio.transcribe", "audio", "Transcribe audio with timing",
    [p("audio","audio","Source audio")],[p("transcript","transcript","Transcript with word timing")], {execution:["async","streaming"]}),
  spec("audio.diarize", "audio", "Separate and identify speakers",
    [p("audio","audio","Source audio")],[p("speakers","structured-data","Speaker turns and tracks")]),
  spec("audio.speech", "audio", "Generate speech",
    [p("script","script","Speech text"),p("voice","voice-profile","Approved voice profile")],
    [p("audio","audio","Generated speech")], {approvals:["paid-execution","voice"]}),
  spec("audio.clone", "audio", "Create authorized voice profile",
    [p("samples","audio","Authorized voice samples",true,true),p("consent","structured-data","Voice consent grant")],
    [p("voice","voice-profile","Voice profile")], {approvals:["paid-execution","voice"]}),
  spec("audio.sound-design", "audio", "Generate music and sound effects",
    [p("prompt","prompt","Sound design direction"),p("duration","structured-data","Duration and timing")],
    [p("audio","audio","Sound design assets")], {approvals:["paid-execution"]}),
  spec("audio.lipsync", "audio", "Synchronize speech to presenter",
    [p("video","video","Presenter video"),p("audio","audio","Speech audio"),p("consent","structured-data","Likeness and voice permission")],
    [p("video","video","Lip-synchronized video")], {approvals:["paid-execution","likeness","voice"]}),
  spec("localization.translate", "localization", "Translate and localize content",
    [p("source","asset","Source media or script"),p("language","structured-data","Target locale"),p("glossary","glossary","Terminology rules",false)],
    [p("localized","asset","Localized media and text")], {approvals:["paid-execution"]}),
  spec("localization.dub", "localization", "Dub and synchronize language version",
    [p("source","video","Source video"),p("transcript","transcript","Source transcript"),p("language","structured-data","Target locale")],
    [p("localized","video","Dubbed and synchronized output")], {approvals:["paid-execution","voice"]}),
  spec("enhance.upscale", "enhancement", "Upscale media",
    [p("source","asset","Image or video source"),p("settings","structured-data","Resolution and enhancement model")],
    [p("media","asset","Enhanced media")]),
  spec("enhance.denoise", "enhancement", "Denoise media",
    [p("source","asset","Source media"),p("strength","structured-data","Denoise settings")],[p("media","asset","Denoised media")]),
  spec("enhance.interpolate", "enhancement", "Interpolate frames",
    [p("video","video","Source video"),p("target-fps","structured-data","Target frame rate")],[p("video","video","Interpolated video")]),
  spec("enhance.stabilize", "enhancement", "Stabilize video",
    [p("video","video","Source video")],[p("video","video","Stabilized video")]),
  spec("enhance.remove-object", "enhancement", "Remove object with tracked mask",
    [p("video","video","Source video"),p("mask","mask","Tracked object mask")],[p("video","video","Reconstructed video")]),
  spec("workflow.validate", "workflow", "Validate workflow graph",
    [p("graph","structured-data","Workflow definition")],[p("report","structured-data","Port, dependency and policy validation")], {execution:["sync"]}),
  spec("workflow.simulate", "workflow", "Simulate workflow without paid execution",
    [p("graph","structured-data","Validated graph")],[p("simulation","structured-data","Dry-run plan and missing inputs")], {execution:["sync"]}),
  spec("workflow.execute", "workflow", "Execute approved workflow snapshot",
    [p("graph","structured-data","Immutable validated run snapshot"),p("approval","structured-data","Required approvals")],
    [p("run","structured-data","Run state and output lineage")], {approvals:["paid-execution","external-action"]}),
  spec("agent.plan", "agent", "Plan multi-step creative task",
    [p("goal","prompt","User outcome"),p("context","asset","Project context",false,true)],
    [p("plan","structured-data","Editable execution plan")], {execution:["interactive","sync"]}),
  spec("agent.checkpoint", "agent", "Persist and resume task checkpoint",
    [p("run","structured-data","Current task state")],[p("checkpoint","structured-data","Recoverable checkpoint")], {execution:["sync"]}),
  spec("campaign.product-ingest", "campaign", "Ingest product facts and media",
    [p("url","prompt","Product page URL"),p("assets","product-reference","Product images",false,true)],
    [p("product","structured-data","Source-linked product profile")], {execution:["async"]}),
  spec("campaign.variants", "campaign", "Generate campaign variant matrix",
    [p("campaign","structured-data","Campaign brief"),p("brand","brand-kit","Brand kit"),p("product","structured-data","Product profile")],
    [p("variants","asset","Creative variants",true,true)], {approvals:["paid-execution"]}),
  spec("design.autofill", "design", "Populate brand template from data",
    [p("template","asset","Approved template"),p("data","structured-data","Rows or records")],
    [p("designs","asset","Generated design set",true,true)]),
  spec("assets.ingest", "assets", "Ingest and fingerprint asset",
    [p("asset","asset","Upload or remote asset")],[p("record","structured-data","Metadata, checksum and lineage")], {execution:["sync","async"]}),
  spec("assets.package", "assets", "Package project for delivery",
    [p("assets","asset","Selected assets",true,true),p("manifest","structured-data","Export metadata")],
    [p("package","asset","Portable package")]),
  spec("collaboration.review", "collaboration", "Collect timecoded review",
    [p("asset","asset","Reviewable output"),p("comments","structured-data","Review comments",false,true)],
    [p("decision","structured-data","Review state and decisions")], {execution:["interactive"]}),
  spec("integration.webhook", "integration", "Receive verified provider event",
    [p("event","structured-data","Signed event and deduplication key")],[p("job-update","structured-data","Normalized job event")], {execution:["sync"]}),
  spec("operations.cost-estimate", "operations", "Estimate execution cost",
    [p("plan","structured-data","Validated plan and provider options")],[p("estimate","structured-data","Cost range and usage assumptions")], {execution:["sync"]}),

  spec("spatial.scene", "spatial", "Manage 3D scene and assets",
    [p("scene","3d-scene","Scene graph and dependencies"),p("assets","asset","Linked models and textures",false,true)],
    [p("scene","3d-scene","Versioned 3D scene package")], {execution:["local","sync"]}),
  spec("spatial.procedural", "spatial", "Build procedural geometry and materials",
    [p("scene","3d-scene","Target scene"),p("graph","structured-data","Procedural node graph")],
    [p("scene","3d-scene","Updated procedural scene")], {execution:["local"]}),
  spec("spatial.animation", "spatial", "Rig and animate character",
    [p("mesh","mesh","Character mesh"),p("motion","motion-reference","Motion capture or animation reference")],
    [p("scene","3d-scene","Animated scene")], {execution:["local","async"]}),
  spec("spatial.render", "spatial", "Render 3D scene",
    [p("scene","3d-scene","Scene and dependencies"),p("camera","camera-data","Camera setup"),p("settings","structured-data","Render settings")],
    [p("frames","asset","Rendered frames",true,true)], {execution:["local","async"]}),
  spec("production.track", "production", "Track production work",
    [p("production","structured-data","Project, sequence, shot and task records")],
    [p("status","structured-data","Assignments, dependencies and progress")], {execution:["sync"]}),
  spec("production.review", "production", "Review and approve versioned media",
    [p("asset","asset","Specific version to review"),p("notes","structured-data","Frame-accurate notes",false,true)],
    [p("decision","structured-data","Review outcome and resolved notes")], {execution:["interactive"]}),
  spec("production.compare", "production", "Compare media versions",
    [p("versions","asset","Two or more ordered versions",true,true)],
    [p("comparison","asset","Comparison view or report")], {execution:["local","sync"]}),
  spec("capture.record", "capture", "Capture synchronized media sources",
    [p("devices","structured-data","Camera, microphone and screen sources"),p("session","structured-data","Capture session configuration")],
    [p("tracks","asset","Recorded source tracks",true,true)], {execution:["local","interactive"]}),
  spec("capture.live", "capture", "Operate live capture session",
    [p("sources","asset","Live source inputs",true,true),p("settings","structured-data","Stream and recording settings")],
    [p("recording","asset","Live recording and health manifest")], {execution:["interactive"]}),
  spec("media.ingest", "capture", "Ingest and verify source media",
    [p("sources","asset","Source files and cards",true,true)],
    [p("ingest","structured-data","Checksum, metadata and transfer report")], {execution:["local","async"]}),
  spec("media.proxy", "capture", "Create and link proxies",
    [p("originals","asset","Original source media",true,true),p("profile","structured-data","Proxy profile")],
    [p("proxies","proxy","Proxy assets linked to originals",true,true)], {execution:["local","async"]}),
  spec("timeline.interchange", "capture", "Import or export timeline interchange",
    [p("timeline","timeline","Editable timeline"),p("package","timeline-package","Interchange package")],
    [p("result","timeline-package","Round-trip package and compatibility report")], {execution:["local","sync"]}),
  spec("quality.preflight", "quality", "Validate media delivery requirements",
    [p("asset","asset","Candidate deliverable"),p("profile","structured-data","Target delivery profile")],
    [p("report","structured-data","Technical and accessibility checks")], {execution:["sync"]})
] as const;

export function validateCapabilityAtlas(
  definitions: readonly CapabilityDefinition[] = CAPABILITY_ATLAS
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const item of definitions) {
    if (!item.id.trim()) issues.push("Capability ID cannot be empty.");
    if (ids.has(item.id)) issues.push(`Duplicate capability ID: ${item.id}`);
    ids.add(item.id);
    if (!Number.isInteger(item.version) || item.version < 1) issues.push(`Invalid version for ${item.id}`);
    if (!item.label.trim()) issues.push(`Missing label for ${item.id}`);
    if (item.outputs.length === 0) issues.push(`Capability has no outputs: ${item.id}`);
    for (const [direction, ports] of [["input", item.inputs], ["output", item.outputs]] as const) {
      const portIds = new Set<string>();
      for (const port of ports) {
        if (portIds.has(port.id)) issues.push(`Duplicate ${direction} port ID in ${item.id}: ${port.id}`);
        portIds.add(port.id);
        if (!port.description.trim()) issues.push(`Missing port description in ${item.id}: ${port.id}`);
      }
    }
    if (item.readiness === "tested" && item.evidence === "unverified") {
      issues.push(`Tested capability cannot have unverified evidence: ${item.id}`);
    }
  }
  return { valid: issues.length === 0, issues };
}

export function getCapabilitiesByDomain(domain: CapabilityDomain): CapabilityDefinition[] {
  return CAPABILITY_ATLAS.filter(item => item.domain === domain);
}

export function getCapability(id: string): CapabilityDefinition | undefined {
  return CAPABILITY_ATLAS.find(item => item.id === id);
}
