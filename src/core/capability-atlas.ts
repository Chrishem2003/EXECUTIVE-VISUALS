/**
 * Provider-neutral capability atlas.
 *
 * This is a product contract and discovery registry, not a claim that every
 * capability has an executable provider adapter. Only entries with tested
 * evidence and a configured adapter may be run.
 */
export type CapabilityDomain =
  | "direction" | "preproduction" | "identity" | "image" | "video"
  | "cinema" | "editing" | "motion" | "audio" | "localization" | "enhancement"
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
  | "glossary" | "timeline" | "structured-data" | "asset" | "creative-set" | "character" | "storyboard" | "3d-scene" | "mesh" | "camera-data" | "timecode" | "proxy" | "timeline-package";

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
  approvals?: Array<"paid-execution" | "likeness" | "voice" | "publishing" | "external-action" | "destructive-action" | "source-rights" | "brand-approval" | "recording-consent" | "render-budget" | "batch-budget">;
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
    [p("image","image","Generated image")], {readiness:"credentials-required",approvals:["paid-execution"],notes:"Server-side prompt-only image gateway is disabled by default; requires a completed upstream human-approval node and validated base64 image output. Reference-image and brand-kit conditioning are not supported by the current generic adapter."}),
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
    [p("source","video","Video source"),p("settings","structured-data","Target output dimensions")],
    [p("media","video","Scaled video derivative")], {readiness:"tested",execution:["local"],notes:"Uses bounded FFmpeg scale/pad processing. This is resolution scaling, not learned super-resolution."}),
  spec("enhance.ai-video-upscale", "enhancement", "Enhance video with AI super-resolution",
    [p("source","video","Immutable source video"),p("settings","structured-data","Verified model, scale and bounded processing settings")],
    [p("derivative","video","Framewise AI-enhanced video derivative")], {readiness:"tested",execution:["local"],notes:"Requires installed Real-ESRGAN weights, explicit worker execution enablement and model-specific five-category human-reviewed quality evidence. The processor is bounded to 300 frames, 10 minutes, 250 MiB input and 40 MP output. Framewise inference does not certify temporal consistency; every derivative requires human review."}),
  spec("enhance.denoise", "enhancement", "Denoise media",
    [p("source","video","Video source"),p("strength","structured-data","Bounded spatial and temporal denoise settings")],[p("media","video","Denoised video derivative")], {readiness:"tested",execution:["local"],notes:"Uses the FFmpeg hqdn3d filter; neural restoration is a separate unimplemented capability."}),
  spec("enhance.interpolate", "enhancement", "Interpolate frames",
    [p("video","video","Source video"),p("target-fps","structured-data","Target frame rate (24–60 fps)")],[p("video","video","Interpolated video")], {readiness:"tested",execution:["local"],notes:"Uses FFmpeg minterpolate. Results depend on motion complexity and are not equivalent to a learned neural frame-generation model."}),
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
    [p("report","structured-data","Technical and accessibility checks")], {execution:["sync"]}),

  spec("timeline.sequence", "editing", "Create and version an editorial sequence",
    [p("project","structured-data","Project and sequence settings"),p("frame-rate","structured-data","Rational frame rate")],
    [p("timeline","timeline","Versioned editorial timeline")], {execution:["sync"]}),
  spec("timeline.track", "editing", "Manage ordered media tracks",
    [p("timeline","timeline","Target sequence"),p("track","structured-data","Track role and ordering")],
    [p("timeline","timeline","Updated sequence")], {execution:["sync"]}),
  spec("timeline.clip", "editing", "Trim, split and place timeline clips",
    [p("timeline","timeline","Target sequence"),p("asset","asset","Source asset"),p("range","timecode","Source and record ranges")],
    [p("timeline","timeline","Updated clip edit")], {execution:["sync"]}),
  spec("timeline.relink", "editing", "Relink missing source media",
    [p("timeline","timeline","Sequence with offline media"),p("manifest","structured-data","Asset ID and path mapping")],
    [p("timeline","timeline","Relinked sequence and missing-media report")], {execution:["sync"]}),
  spec("timeline.export", "editing", "Export editorial interchange package",
    [p("timeline","timeline","Approved sequence"),p("format","structured-data","Interchange format and version")],
    [p("package","timeline-package","Portable timeline and media reference package")], {execution:["local","sync"]}),
  spec("collaboration.lock", "collaboration", "Acquire project or sequence edit lock",
    [p("resource","structured-data","Project, sequence or asset identifier"),p("lease","structured-data","Lock duration and owner")],
    [p("lock","structured-data","Lease token and lock state")], {execution:["sync"]}),
  spec("collaboration.publish", "collaboration", "Publish a reviewed revision to collaborators",
    [p("revision","structured-data","Immutable revision snapshot"),p("note","document","Publish note",false)],
    [p("publication","structured-data","Published revision and notification record")], {execution:["async"],approvals:["external-action"]}),
  spec("collaboration.annotation", "collaboration", "Attach frame-accurate review annotation",
    [p("asset","asset","Specific asset version"),p("timecode","timecode","Frame or time position"),p("annotation","document","Comment or drawing annotation")],
    [p("review-note","structured-data","Version-bound review note")], {execution:["sync"]}),
  spec("collaboration.presence", "collaboration", "Track collaborator presence and activity",
    [p("project","structured-data","Project and participant context")],
    [p("presence","structured-data","Online status and active resource")], {execution:["streaming"]}),
  spec("workflow.subgraph", "workflow", "Create reusable workflow subgraph",
    [p("graph","structured-data","Selected node and edge group"),p("interface","structured-data","Exposed input and output ports")],
    [p("subgraph","structured-data","Versioned reusable subworkflow")], {execution:["sync"]}),
  spec("workflow.batch", "workflow", "Run workflow across a batch of inputs",
    [p("workflow","structured-data","Approved workflow version"),p("items","asset","Batch input set",true,true)],
    [p("results","structured-data","Per-item outcomes and partial failures",true,true)], {execution:["async"]}),
  spec("workflow.partial-run", "workflow", "Execute selected outputs and dependencies only",
    [p("run","structured-data","Immutable workflow run snapshot"),p("targets","structured-data","Selected target nodes")],
    [p("result","structured-data","Partial execution plan and node results")], {execution:["async"]}),
  spec("assets.proxy-cache", "assets", "Generate and invalidate preview proxies and caches",
    [p("source","asset","Immutable original"),p("profile","structured-data","Preview dimensions, codec and cache policy")],
    [p("proxy","proxy","Linked proxy and cache manifest")], {execution:["local","async"]}),
  spec("assets.verify-integrity", "assets", "Verify checksum and asset lineage",
    [p("asset","asset","Source or derivative"),p("expected-hash","structured-data","Expected SHA-256",false)],
    [p("report","structured-data","Integrity, provenance and lineage report")], {execution:["local","sync"]}),
  spec("capture.resumable-ingest", "capture", "Resume interrupted media ingest",
    [p("upload","structured-data","Upload session and chunk manifest"),p("source","asset","Source file or device media")],
    [p("asset","asset","Verified completed media asset")], {execution:["async"]}),
  spec("speech.diarize", "audio", "Separate speakers and align transcript",
    [p("audio","audio","Source audio"),p("language","structured-data","Optional language hint",false)],
    [p("transcript","transcript","Speaker-labelled transcript and timecodes")], {execution:["async"]}),
  spec("speech.remove-filler", "audio", "Remove filler words and long silences",
    [p("audio","audio","Source speech"),p("transcript","transcript","Aligned transcript",false)],
    [p("audio","audio","Edited speech audio"),p("edit-map","structured-data","Removed ranges and edit decisions")], {execution:["async"]}),
  spec("speech.glossary-apply", "localization", "Apply pronunciation and translation glossary",
    [p("text","transcript","Transcript or script"),p("glossary","glossary","Approved terminology and pronunciation rules")],
    [p("text","transcript","Glossary-normalized text")], {execution:["sync"]}),
  spec("runtime.discover-models", "operations", "Discover installed model and node capabilities",
    [p("runtime","structured-data","Local runtime endpoint and version")],
    [p("inventory","structured-data","Model, node, dependency and version inventory")], {execution:["local","sync"]}),
  spec("runtime.preflight", "operations", "Preflight execution against runtime resources",
    [p("workflow","structured-data","Validated workflow snapshot"),p("inventory","structured-data","Installed models and operators"),p("hardware","structured-data","Memory and device resources")],
    [p("report","structured-data","Compatibility, resource and missing-dependency report")], {execution:["local","sync"]}),
  spec("runtime.schedule", "operations", "Schedule jobs across eligible workers",
    [p("job","structured-data","Approved job and priority"),p("workers","structured-data","Worker capability and resource inventory")],
    [p("assignment","structured-data","Worker lease and execution placement")], {execution:["async"]}),
  spec("review.share-link", "collaboration", "Create controlled review link",
    [p("asset","asset","Immutable review version"),p("policy","structured-data","Expiry, passcode and permission policy")],
    [p("link","structured-data","Revocable review URL and access policy")], {execution:["sync"],approvals:["external-action"]}),
  spec("review.approval", "collaboration", "Record approval or requested changes",
    [p("review","structured-data","Review session"),p("decision","structured-data","Approve, reject or request changes")],
    [p("decision-record","structured-data","Auditable approval state")], {execution:["sync"]}),
  spec("timeline.render-master", "editing", "Render a timeline to a video master",
    [p("timeline","timeline","Validated and saved timeline"),p("render-profile","structured-data","Output codec, dimensions and frame rate",false)],
    [p("master","video","Rendered MP4 master"),p("render-report","structured-data","Render settings and source lineage")],
    {evidence:"inferred",readiness:"adapter-required",execution:["local","async"]}),

  spec("video.keyframe-control", "video", "Generate video between pinned keyframes",
    [p("prompt","prompt","Motion and scene direction",false),p("first-frame","start-frame","Pinned opening frame",false),p("last-frame","end-frame","Pinned closing frame",false),p("keyframes","keyframe","Timestamped interior keyframes",false,true),p("references","identity-reference","Subject or style references",false,true)],
    [p("video","video","Video following the supplied frame constraints")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async"],approvals:["paid-execution","source-rights"],notes:"Frame counts, timestamps, spacing, and combinations are model-version-specific; validate against the selected model contract."}),
  spec("video.reference-directing", "video", "Direct video with subject, style and audio references",
    [p("prompt","prompt","Scene and movement direction"),p("subject-references","identity-reference","Subject continuity references",false,true),p("style-references","style-reference","Style and look references",false,true),p("audio-references","audio","Optional sound references",false,true)],
    [p("video","video","Reference-conditioned video")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async"],approvals:["paid-execution","source-rights"],notes:"Reference modalities and maximum counts differ by model. Frame anchors and reference assets are distinct input modes."}),
  spec("video.extend-scene", "video", "Continue or extend an existing video scene",
    [p("source-video","video","Source clip to continue"),p("continuation","prompt","Continuation direction"),p("last-frame","end-frame","Optional continuation anchor",false)],
    [p("extended-video","video","Extended video with source lineage")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async"],approvals:["paid-execution","source-rights"]}),
  spec("video.conversational-edit", "video", "Iteratively edit video through a stateful session",
    [p("source-video","video","Current video revision"),p("instruction","prompt","Requested change"),p("session","structured-data","Prior edit session and revision",false)],
    [p("video","video","Revised video"),p("edit-plan","structured-data","Structured edit decisions and revision lineage")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["interactive","async"],approvals:["paid-execution","source-rights"],notes:"Session state, checkpoints, source snapshots and edit versions must be preserved. Do not treat a conversational edit as a stateless generation."}),
  spec("video.native-audio", "video", "Generate synchronized video with native audio",
    [p("prompt","prompt","Visual and motion direction"),p("audio-direction","structured-data","Dialogue, ambience and sound direction",false),p("voice-reference","voice-profile","Authorized voice reference",false)],
    [p("video","video","Video stream"),p("audio","audio","Synchronized audio stream")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async"],approvals:["paid-execution","voice","source-rights"]}),
  spec("speech.stream-tts", "audio", "Stream speech from incremental text",
    [p("text","script","Text chunks or completed script"),p("voice","voice-profile","Voice and delivery profile"),p("language","structured-data","Language and locale",false)],
    [p("audio","audio","Streamed speech audio"),p("alignment","structured-data","Chunk and word timing metadata",false)],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["streaming","interactive"],approvals:["paid-execution","voice"]}),
  spec("speech.stream-transcription", "audio", "Transcribe audio with partial streaming events",
    [p("audio","audio","Live or uploaded audio"),p("language","structured-data","Language hint",false),p("glossary","glossary","Names, acronyms and domain vocabulary",false)],
    [p("transcript","transcript","Partial and final transcript events"),p("segments","timecode","Timed transcript segments",false)],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["streaming","async"]}),
  spec("speech.word-alignment", "audio", "Align transcript words to audio timestamps",
    [p("audio","audio","Source speech audio"),p("transcript","transcript","Reviewed transcript")],
    [p("alignment","structured-data","Word-level timing and confidence metadata")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async"]}),
  spec("speech.voice-isolation", "audio", "Isolate speech and suppress background noise",
    [p("audio","audio","Source recording"),p("profile","structured-data","Voice isolation profile",false)],
    [p("isolated-audio","audio","Clean speech track"),p("diagnostics","structured-data","Noise and processing diagnostics",false)],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["streaming","async"]}),
  spec("speech.live-translation", "localization", "Translate incoming speech in real time",
    [p("audio","audio","Live source speech"),p("target-language","structured-data","Target locale"),p("voice","voice-profile","Authorized output voice",false)],
    [p("translated-audio","audio","Translated speech stream"),p("transcript","transcript","Source and translated segments")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["streaming","interactive"],approvals:["paid-execution","voice"]}),
  spec("agent.text-generate", "agent", "Generate and transform text",
    [p("prompt","prompt","User instruction or source text"),p("system","prompt","Optional system instruction",false)],
    [p("text","prompt","Generated or transformed text"),p("usage","structured-data","Normalized token usage metadata",false)],
    {evidence:"inferred",readiness:"credentials-required",execution:["async"],approvals:["paid-execution"],notes:"Server-side chat-completions-compatible gateway. Disabled by default; requires a completed upstream human-approval node and server-side gateway configuration."}),
  spec("integration.discover-model-capabilities", "integration", "Discover model-specific inputs, limits and costs",
    [p("provider","structured-data","Configured provider adapter"),p("model","structured-data","Selected model and API version")],
    [p("capabilities","structured-data","Supported modes, reference types, limits, pricing units and version constraints")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["sync"],notes:"A model catalogue is versioned data. Never infer that a feature or input combination is supported by every model in a provider family."}),
  spec("assets.retention-verify", "assets", "Verify output availability and retention policy",
    [p("asset","asset","Generated or uploaded asset"),p("policy","structured-data","Retention and ownership requirements")],
    [p("retention","structured-data","Expiry, durable-copy and retrieval status")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async","sync"]}),

  spec("operations.model-benchmark", "operations", "Benchmark candidate models against a shared evaluation set",
    [p("dataset","structured-data","Evaluation prompts and expected criteria"),p("models","structured-data","Candidate model and adapter set")],
    [p("report","document","Quality, latency, reliability and token-usage report")],
    {evidence:"inferred",readiness:"adapter-required",execution:["async"],approvals:["paid-execution"],notes:"Run only against explicitly approved model endpoints. Compare like-for-like inputs and retain benchmark provenance."}),
  spec("operations.model-route", "operations", "Route a task to the best eligible model",
    [p("task","structured-data","Task type and constraints"),p("policy","structured-data","Quality, latency, cost, region and rights policy")],
    [p("route","structured-data","Selected adapter, model and routing rationale")],
    {evidence:"inferred",readiness:"adapter-required",execution:["sync"],notes:"Never route to a model that violates task, data residency, rights, budget or consent constraints."}),
  spec("design.template-autofill", "design", "Populate reusable designs from structured data",
    [p("template","asset","Approved design template"),p("data","structured-data","Variable text, product and campaign data"),p("assets","asset","Optional image and logo assets",false)],
    [p("designs","creative-set","Generated design variants")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async"],approvals:["brand-approval"]}),
  spec("design.brand-glossary", "design", "Manage brand terminology and localization rules",
    [p("terms","structured-data","Preferred terms, pronunciation and translation rules")],
    [p("glossary","structured-data","Versioned brand glossary")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["sync"]}),
  spec("collaboration.live-presence", "collaboration", "Coordinate presence and editing locks in shared sessions",
    [p("session","structured-data","Project and active document session")],
    [p("presence","structured-data","Participants, cursors, locks and session state")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["streaming","interactive"]},),
  spec("editing.proxy-review", "editing", "Review low-bandwidth proxies with source-linked annotations",
    [p("original","asset","Original high-resolution media"),p("proxy","proxy","Review proxy",false),p("annotations","structured-data","Timecoded review notes",false)],
    [p("review","structured-data","Proxy review and source relink metadata")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async"]}),
  spec("capture.remote-recording", "capture", "Record remote participants as synchronized isolated tracks",
    [p("participants","structured-data","Participant identities and recording devices"),p("consent","structured-data","Recording and likeness consent records")],
    [p("tracks","asset","Synchronized source tracks"),p("sync","timecode","Shared recording timebase")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["interactive","async"],approvals:["recording-consent"]}),
  spec("production.analytics-feedback", "production", "Turn campaign performance into creative recommendations",
    [p("campaign","structured-data","Published campaign and variants"),p("analytics","structured-data","Reach, retention, conversion and engagement metrics")],
    [p("insights","document","Evidence-backed performance analysis"),p("recommendations","creative-set","Next creative tests and variants")],
    {evidence:"inferred",readiness:"adapter-required",execution:["async"]}),
  spec("motion.template-render", "motion", "Render parameterized motion-graphics templates",
    [p("template","asset","HTML, motion or compositing template"),p("data","structured-data","Dynamic text, media and timing variables"),p("assets","asset","Brand and media assets",false)],
    [p("video","video","Rendered motion-graphics output")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async"],approvals:["render-budget"]}),
  spec("video.continuity-check", "video", "Evaluate visual and narrative continuity across shots",
    [p("storyboard","storyboard","Ordered shot plan"),p("characters","character","Reusable character identities",false),p("references","image","Approved style and continuity references",false)],
    [p("report","document","Continuity issues and corrective suggestions")],
    {evidence:"inferred",readiness:"adapter-required",execution:["async"]}),
  spec("assets.semantic-search", "assets", "Find media by meaning, content and production context",
    [p("query","prompt","Natural-language asset query"),p("scope","structured-data","Workspace, project and permission scope")],
    [p("matches","asset","Ranked authorized asset references")],
    {evidence:"inferred",readiness:"adapter-required",execution:["async"]}),
  spec("workflow.version-diff", "workflow", "Compare two workflow revisions",
    [p("before","structured-data","Earlier immutable workflow revision"),p("after","structured-data","Later immutable workflow revision")],
    [p("diff","document","Node, edge, config and approval changes")],
    {evidence:"inferred",readiness:"adapter-required",execution:["sync"]}),
  spec("video.transform-vehicle", "video", "Transform or replace a vehicle in existing footage",
    [p("source","video","Owner-authorized source video"),p("target","prompt","Vehicle replacement direction"),p("references","image","Approved vehicle reference images",false)],
    [p("video","video","New transformed video derivative")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async"],approvals:["source-rights","paid-execution"]}),
  spec("video.transform-wardrobe", "video", "Transform wardrobe in existing footage",
    [p("source","video","Owner-authorized source video"),p("target","prompt","Wardrobe transformation direction"),p("references","image","Approved wardrobe reference images",false)],
    [p("video","video","New transformed video derivative")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async"],approvals:["source-rights","paid-execution"]}),
  spec("video.transform-object", "video", "Replace or remove selected objects in existing footage",
    [p("source","video","Owner-authorized source video"),p("target","prompt","Object replacement or removal direction"),p("references","image","Approved replacement references",false)],
    [p("video","video","New transformed video derivative")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async"],approvals:["source-rights","paid-execution"]}),
  spec("video.transform-scene", "video", "Transform the background or visual style of existing footage",
    [p("source","video","Owner-authorized source video"),p("target","prompt","Scene or style transformation direction"),p("references","image","Approved scene/style references",false)],
    [p("video","video","New transformed video derivative")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async"],approvals:["source-rights","paid-execution"]}),
  spec("video.transform-person", "video", "Replace a person in existing footage with consent",
    [p("source","video","Owner-authorized source video"),p("target","prompt","Person replacement direction"),p("references","image","Approved identity reference images",false),p("consent","structured-data","Source rights and explicit subject consent")],
    [p("video","video","New transformed video derivative")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async"],approvals:["source-rights","likeness","paid-execution"]}),
  spec("video.finish-pipeline", "video", "Run a checkpointed video transformation and finishing pipeline",
    [p("source","video","Immutable source video"),p("steps","structured-data","Approved edit, upscale, frame-rate, HDR and audio finishing steps")],
    [p("derivative","video","Versioned final video derivative"),p("lineage","structured-data","Step checkpoints, model metadata, costs and source lineage")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async"],approvals:["source-rights","paid-execution"]}),
  spec("workflow.batch-execution", "workflow", "Execute a workflow against a batch of inputs",
    [p("workflow","structured-data","Validated immutable workflow revision"),p("items","structured-data","Input rows and per-item variables")],
    [p("jobs","structured-data","Independent child job and result records")],
    {evidence:"publicly-documented",readiness:"adapter-required",execution:["async"],approvals:["batch-budget"]}),
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
