type View = "overview" | "director" | "avatar" | "cinema" | "image" | "video" | "enhance" | "voice" | "campaign" | "library";
type Job = { id: string; title: string; kind: string; provider: string; status: "planned" | "needs-provider"; createdAt: string; prompt: string };
type Brief = { id: string; title: string; type: string; audience: string; style: string; prompt: string; createdAt: string };
type Asset = { id: string; name: string; type: string; size: number; addedAt: string };
const KEY = "executive-visuals:v1";
const state = {
  view: "overview" as View,
  jobs: [] as Job[],
  briefs: [] as Brief[],
  assets: [] as Asset[],
  query: "",
  previewUrls: new Map<string, string>()
};
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const id = () => crypto.randomUUID();
function load() {
  try { const saved = JSON.parse(localStorage.getItem(KEY) || "{}"); state.jobs = saved.jobs || []; state.briefs = saved.briefs || []; state.assets = saved.assets || []; } catch { /* start clean on malformed local state */ }
}
function save() { localStorage.setItem(KEY, JSON.stringify({ jobs: state.jobs, briefs: state.briefs, assets: state.assets })); }
const nav: {id: View; label: string; icon: string; group: string}[] = [
  {id:"overview",label:"Overview",icon:"◫",group:"Workspace"},
  {id:"director",label:"AI Director",icon:"✳",group:"Create"},
  {id:"avatar",label:"Avatar Studio",icon:"◉",group:"Create"},
  {id:"cinema",label:"Cinematic Studio",icon:"▣",group:"Create"},
  {id:"image",label:"Image Studio",icon:"▧",group:"Create"},
  {id:"video",label:"Video Studio",icon:"▷",group:"Create"},
  {id:"enhance",label:"Enhancement Lab",icon:"✧",group:"Create"},
  {id:"voice",label:"Voice & Audio",icon:"♫",group:"Create"},
  {id:"campaign",label:"Campaign Studio",icon:"◇",group:"Create"},
  {id:"library",label:"Asset Library",icon:"▤",group:"Manage"}
];
const configs: Record<Exclude<View,"overview"|"library">,{eyebrow:string;title:string;description:string;kind:string;placeholder:string;options:string[]}> = {
 director:{eyebrow:"CREATIVE INTELLIGENCE",title:"AI Director",description:"Turn a rough idea into a production-ready creative brief.",kind:"Production plan",placeholder:"Describe the story, audience, platform, mood and outcome…",options:["Explainer video","Brand story","Social short","Product launch"]},
 avatar:{eyebrow:"PRESENTER WORKFLOWS",title:"Avatar Studio",description:"Plan consent-based digital presenter videos and reusable presenter profiles.",kind:"Avatar video",placeholder:"Describe the presenter, script, delivery, gestures and language…",options:["Presenter video","Talking portrait","Multilingual presenter","Training module"]},
 cinema:{eyebrow:"SHOT DESIGN & GENERATION",title:"Cinematic Studio",description:"Design scenes with camera intent, lenses, movement, lighting and continuity.",kind:"Cinematic scene",placeholder:"Describe the scene, subject, action, environment and visual direction…",options:["Text to video","Image to video","Multi-shot sequence","Product film"]},
 image:{eyebrow:"IMAGE CREATION",title:"Image Studio",description:"Create image briefs, variations and reference-led visual directions.",kind:"Image generation",placeholder:"Describe subject, composition, lighting, lens, palette and aspect ratio…",options:["Text to image","Reference variation","Product image","Editorial portrait"]},
 video:{eyebrow:"EDIT & ASSEMBLE",title:"Video Studio",description:"Plan edits, scene assembly, captions, audio and delivery formats.",kind:"Video edit",placeholder:"Describe the footage, edit rhythm, captions, soundtrack and export…",options:["Assemble scenes","Add captions","Social cutdowns","Reformat video"]},
 enhance:{eyebrow:"RESTORE & REFINE",title:"Enhancement Lab",description:"Prepare enhancement workflows for image and video assets.",kind:"Enhancement",placeholder:"Describe the quality issue and desired result. Add a reference asset in the library…",options:["Upscale & restore","Portrait retouch","Remove object","Denoise & stabilize"]},
 voice:{eyebrow:"SPEECH & LOCALIZATION",title:"Voice & Audio",description:"Plan narration, voiceover, transcription, dubbing and localization.",kind:"Voice workflow",placeholder:"Describe the voice, language, tone, pacing and audio requirements…",options:["Voiceover","Transcription","Translation & dubbing","Lip-sync plan"]},
 campaign:{eyebrow:"CAMPAIGN PRODUCTION",title:"Campaign Studio",description:"Turn a product or campaign idea into creative variants for each channel.",kind:"Campaign",placeholder:"Describe the product, audience, offer, proof points and campaign goal…",options:["Product advertisement","UGC concept","Social campaign","Batch variations"]}
};
function shell() {
  $("#app").innerHTML = `
  <div class="app-shell">
    <aside class="sidebar">
      <a class="brand" href="#" data-view="overview"><span class="brand-mark">EV</span><span><b>EXECUTIVE</b><small>VISUALS STUDIO</small></span></a>
      <div class="workspace-switch"><span class="workspace-dot"></span><span><b>My workspace</b><small>Personal studio</small></span><span class="muted">⌄</span></div>
      <nav id="navigation"></nav>
      <div class="sidebar-bottom"><div class="provider-indicator"><i></i><span><b>Local workspace</b><small>Provider adapters not connected</small></span></div><div class="user-chip"><span class="avatar">CS</span><span><b>Creative account</b><small>Local session</small></span><span class="muted">···</span></div></div>
    </aside>
    <main class="main-area">
      <header class="topbar"><div class="crumb"><span>Workspace</span><b>/</b><strong id="crumb-current">Overview</strong></div><div class="top-actions"><span class="local-pill"><i></i> LOCAL MODE</span><button class="icon-btn" aria-label="Notifications">♧</button><button class="new-project" id="top-create">＋ New brief</button></div></header>
      <section id="content" class="content"></section>
    </main>
  </div>`;
  renderNav(); renderView();
}
function renderNav() {
  const groups = ["Workspace","Create","Manage"];
  $("#navigation").innerHTML = groups.map(group => `<div class="nav-group"><label>${group}</label>${nav.filter(n=>n.group===group).map(n=>`<button class="nav-item ${state.view===n.id?"active":""}" data-view="${n.id}"><span>${n.icon}</span>${n.label}${n.id==="library"?`<em>${state.assets.length}</em>`:""}</button>`).join("")}</div>`).join("");
}
function metric(value:string,label:string,sub:string) { return `<div class="metric-card"><span>${label}</span><strong>${value}</strong><small>${sub}</small></div>`; }
function overview() {
 const recent = state.jobs.slice().reverse().slice(0,4);
 return `<div class="page-heading"><div><div class="eyebrow">YOUR CREATIVE COMMAND CENTRE</div><h1>Make something <span>remarkable.</span></h1><p>One workspace to plan, create, refine and deliver visual stories.</p></div><button class="primary-btn" data-view="director">✳ Start creating</button></div>
 <div class="hero-panel"><div class="hero-copy"><span class="hero-tag">THE CREATIVE WORKFLOW, REIMAGINED</span><h2>From first thought<br>to final frame.</h2><p>Describe what you want to make. Build a brief, map the shots, choose the right creative tools and keep every asset together.</p><button class="light-btn" data-view="director">Open AI Director <span>→</span></button></div><div class="hero-art"><div class="art-orbit orbit-one"></div><div class="art-orbit orbit-two"></div><div class="art-glow"></div><div class="art-frame frame-back">01 <span>SCENE DESIGN</span></div><div class="art-frame frame-front"><span class="play-mark">▶</span><span class="frame-caption">A NEW PERSPECTIVE</span></div><div class="art-chip chip-a">✦ VISUAL STORYTELLING</div><div class="art-chip chip-b">4K · CREATIVE</div></div></div>
 <div class="metrics-grid">${metric(String(state.briefs.length),"Creative briefs","Saved in this workspace")}${metric(String(state.jobs.length),"Production jobs","Planned workflows")}${metric(String(state.assets.length),"Reference assets","In your library")}${metric("0","Connected providers","Adapters awaiting setup")}</div>
 <div class="section-row"><div><div class="eyebrow">YOUR TOOLKIT</div><h2>Choose your creative space</h2></div><span class="subtle">Eight connected studios · one workflow</span></div>
 <div class="studio-grid">${nav.filter(n=>["director","avatar","cinema","image","video","enhance","voice","campaign"].includes(n.id)).map(n=>`<button class="studio-card" data-view="${n.id}"><span class="studio-icon icon-${n.id}">${n.icon}</span><b>${n.label}</b><small>${configs[n.id as keyof typeof configs].description}</small><span class="card-arrow">↗</span></button>`).join("")}</div>
 <div class="section-row"><div><div class="eyebrow">RECENT ACTIVITY</div><h2>Production queue</h2></div><button class="text-btn" data-view="library">View library →</button></div>${jobList(recent)}`;
}
function jobList(jobs:Job[]) {
 if(!jobs.length) return `<div class="empty-state"><span>✳</span><b>Your production queue is clear.</b><p>Create a brief to start mapping your next project.</p><button class="secondary-btn" data-view="director">Create your first brief</button></div>`;
 return `<div class="job-list">${jobs.map(j=>`<div class="job-row"><span class="job-symbol">✧</span><div class="job-info"><b>${esc(j.title)}</b><small>${esc(j.kind)} · ${new Date(j.createdAt).toLocaleString()}</small></div><span class="status ${j.status}">${j.status==="planned"?"Plan ready":"Provider needed"}</span><button class="more-btn" data-job="${j.id}">•••</button></div>`).join("")}</div>`;
}
function studio(view:Exclude<View,"overview"|"library">) {
 const c=configs[view];
 return `<div class="page-heading"><div><div class="eyebrow">${c.eyebrow}</div><h1>${c.title}</h1><p>${c.description}</p></div><span class="coming-pill">WORKSPACE · LOCAL</span></div>
 <div class="studio-layout"><div class="composer-card"><div class="composer-top"><div><span class="eyebrow">NEW CREATIVE BRIEF</span><h2>What are we making?</h2></div><span class="step-count">01 / 03</span></div>
 <form id="brief-form"><label class="field-label" for="brief-title">Project name</label><input id="brief-title" name="title" placeholder="e.g. The future of clean energy" required maxlength="90"/>
 <label class="field-label" for="brief-type">Creative format</label><select id="brief-type" name="type">${c.options.map(o=>`<option>${o}</option>`).join("")}</select>
 <label class="field-label" for="brief-audience">Audience / destination</label><input id="brief-audience" name="audience" placeholder="e.g. Instagram Reels · young entrepreneurs"/>
 <label class="field-label" for="brief-style">Visual direction</label><select id="brief-style" name="style"><option>Cinematic & photoreal</option><option>Editorial & premium</option><option>Clean & minimal</option><option>Bold & energetic</option><option>Documentary & authentic</option><option>Playful & expressive</option></select>
 <label class="field-label" for="brief-prompt">Creative direction</label><textarea id="brief-prompt" name="prompt" rows="6" placeholder="${c.placeholder}" required></textarea>
 <div class="consent-note"><span>ⓘ</span><p>Only upload or generate likenesses and voices with appropriate rights and consent. This brief is saved locally; no media is sent to a provider.</p></div>
 <button class="primary-btn submit-btn" type="submit">Create production plan <span>→</span></button></form></div>
 <aside class="side-stack"><div class="side-card"><span class="eyebrow">WORKFLOW PREVIEW</span><h3>Your brief becomes a plan</h3><div class="workflow-step"><i>1</i><span><b>Creative brief</b><small>Goal, audience and direction</small></span></div><div class="workflow-step"><i>2</i><span><b>Production breakdown</b><small>Scenes, shots and assets</small></span></div><div class="workflow-step"><i>3</i><span><b>Provider selection</b><small>Choose an available engine</small></span></div><div class="workflow-step"><i>4</i><span><b>Generate & refine</b><small>Review, iterate and export</small></span></div></div>
 <div class="side-card provider-card"><span class="eyebrow">ENGINE STATUS</span><h3>Creative engines</h3><p><i class="status-dot"></i> Local planning engine <b>Ready</b></p><p><i class="status-dot muted-dot"></i> Image generation <b>Not connected</b></p><p><i class="status-dot muted-dot"></i> Video generation <b>Not connected</b></p><p><i class="status-dot muted-dot"></i> Avatar & voice <b>Not connected</b></p><small>Provider integrations will be enabled only after their adapters and credentials are configured securely.</small></div></aside></div>
 <div class="section-row"><div><div class="eyebrow">YOUR WORK</div><h2>Recent ${c.kind.toLowerCase()} jobs</h2></div></div>${jobList(state.jobs.filter(j=>j.kind===c.kind).slice().reverse().slice(0,3))}`;
}
function library() {
 const q=state.query.toLowerCase();
 const jobs=state.jobs.filter(j=>j.title.toLowerCase().includes(q)||j.kind.toLowerCase().includes(q));
 const briefs=state.briefs.filter(b=>b.title.toLowerCase().includes(q)||b.type.toLowerCase().includes(q));
 const assets=state.assets.filter(a=>a.name.toLowerCase().includes(q));
 return `<div class="page-heading"><div><div class="eyebrow">PROJECTS & REFERENCES</div><h1>Your creative library</h1><p>Every brief, production plan and reference asset in one place.</p></div><label class="upload-btn">＋ Add assets<input id="asset-upload" type="file" multiple accept="image/*,video/*,audio/*"/></label></div>
 <div class="library-search"><span>⌕</span><input id="library-query" placeholder="Search briefs, jobs and assets…" value="${esc(state.query)}"/></div>
 <div class="section-row"><div><div class="eyebrow">PROJECT PLANS</div><h2>Creative briefs <span class="count">${briefs.length}</span></h2></div></div>
 <div class="brief-grid">${briefs.length?briefs.map(b=>`<div class="brief-card"><span class="eyebrow">${esc(b.type)}</span><b>${esc(b.title)}</b><p>${esc(b.prompt)}</p><small>${new Date(b.createdAt).toLocaleDateString()}</small></div>`).join(""):`<div class="empty-inline">No briefs found. Create a brief in any studio.</div>`}</div>
 <div class="section-row"><div><div class="eyebrow">PRODUCTION</div><h2>Jobs <span class="count">${jobs.length}</span></h2></div></div>${jobList(jobs)}
 <div class="section-row"><div><div class="eyebrow">REFERENCE MATERIAL</div><h2>Assets <span class="count">${assets.length}</span></h2></div></div>
 <div class="asset-grid">${assets.length?assets.map(a=>`<div class="asset-card"><div class="asset-thumb">${a.type.startsWith("image/")?"▧":a.type.startsWith("video/")?"▷":"♫"}</div><b>${esc(a.name)}</b><small>${(a.size/1024/1024).toFixed(2)} MB · Local session</small></div>`).join(""):`<div class="empty-inline">Your reference shelf is empty. Add images, video or audio references to begin.</div>`}</div>
 <p class="storage-warning">Local prototype: asset metadata persists, but uploaded file bytes and previews are not uploaded to a server and will not survive a page refresh.</p>`;
}
function renderView() {
 $("#crumb-current").textContent=nav.find(n=>n.id===state.view)?.label||"Overview";
 $("#content").innerHTML=state.view==="overview"?overview():state.view==="library"?library():studio(state.view);
 renderNav();
}
function createBrief(form:HTMLFormElement) {
 const data=new FormData(form); const view=state.view as Exclude<View,"overview"|"library">; const c=configs[view];
 const brief:Brief={id:id(),title:String(data.get("title")),type:String(data.get("type")),audience:String(data.get("audience")||""),style:String(data.get("style")||""),prompt:String(data.get("prompt")),createdAt:new Date().toISOString()};
 state.briefs.push(brief);
 state.jobs.push({id:id(),title:brief.title,kind:c.kind,provider:"local-planner",status:"planned",createdAt:brief.createdAt,prompt:`Audience: ${brief.audience}\nStyle: ${brief.style}\n\n${brief.prompt}`});
 save(); state.view="library"; state.query=""; renderView();
}
function addFiles(input:HTMLInputElement) {
 const files=Array.from(input.files||[]);
 for(const file of files) {
   const asset:Asset={id:id(),name:file.name,type:file.type||"application/octet-stream",size:file.size,addedAt:new Date().toISOString()};
   state.assets.push(asset); state.previewUrls.set(asset.id,URL.createObjectURL(file));
 }
 save(); renderView();
}
document.addEventListener("click",e=>{
 const target=e.target as HTMLElement;
 const viewBtn=target.closest<HTMLElement>("[data-view]");
 if(viewBtn){e.preventDefault();const v=viewBtn.dataset.view as View;if(nav.some(n=>n.id===v)){state.view=v;state.query="";renderView();}return;}
 const jobBtn=target.closest<HTMLElement>("[data-job]");
 if(jobBtn){const job=state.jobs.find(j=>j.id===jobBtn.dataset.job);if(job)alert(`${job.title}\n\n${job.kind}\nStatus: ${job.status}\n\n${job.prompt}\n\nThis is a saved production brief, not a generated media file. Connect a compatible provider to execute it.`);}
 if(target.closest("#top-create")){state.view="director";renderView();}
});
document.addEventListener("submit",e=>{if((e.target as HTMLElement).id==="brief-form"){e.preventDefault();createBrief(e.target as HTMLFormElement);}});
document.addEventListener("change",e=>{const t=e.target as HTMLInputElement;if(t.id==="asset-upload")addFiles(t);});
document.addEventListener("input",e=>{const t=e.target as HTMLInputElement;if(t.id==="library-query"){state.query=t.value;const pos=t.selectionStart;renderView();const next=$("#library-query");next.focus();next.setSelectionRange(pos,pos);}});
load(); shell();