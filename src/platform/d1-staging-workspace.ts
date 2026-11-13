import { apiRequest } from "../core/api";
import { buildD1WorkspaceUpdatePayload, type D1WorkspaceDocument } from "./d1-staging-contract";

type D1Project = { id: string; name: string; description?: string; revision: number; settings?: Record<string, unknown> };
type D1Asset = { id: string; projectId: string | null; name: string; mediaType: string; size: number; sha256: string; derivativeOf?: string | null; metadata?: Record<string, unknown>; createdAt: string };
type D1Workspace = { document: D1WorkspaceDocument; revision: number; updatedAt: string };

const state: {
  checked: boolean;
  ready: boolean;
  busy: boolean;
  message: string;
  projects: D1Project[];
  projectId: string;
  workspace: D1Workspace | null;
  assets: D1Asset[];
} = {
  checked: false, ready: false, busy: false,
  message: "This isolated staging workspace is opt-in and does not replace production storage.",
  projects: [], projectId: "", workspace: null, assets: []
};

let initialized = false;
let repaint: () => void = () => {};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const formatBytes = (value: number) => value < 1024 * 1024 ? Math.max(1, Math.round(value / 1024)) + " KB" : (value / 1048576).toFixed(2) + " MB";

async function loadProjectData(projectId: string) {
  if (!UUID.test(projectId)) throw new Error("Select a valid staging project.");
  const [workspace, assets] = await Promise.all([
    apiRequest<D1Workspace>("/api/d1/projects/" + encodeURIComponent(projectId) + "/workspace"),
    apiRequest<{ assets: D1Asset[]; metadataOnly: boolean }>("/api/d1/assets?projectId=" + encodeURIComponent(projectId) + "&limit=50")
  ]);
  state.projectId = projectId;
  state.workspace = workspace;
  state.assets = Array.isArray(assets.assets) ? assets.assets : [];
  if (!assets.metadataOnly) throw new Error("The staging asset endpoint did not confirm metadata-only mode.");
}

async function refresh() {
  if (state.busy) return;
  state.busy = true;
  state.message = "Checking the authenticated staging bridge…";
  repaint();
  try {
    const health = await apiRequest<{ status: string; database: string; metadataOnly: boolean; r2Enabled: boolean }>("/api/d1/health");
    if (health.status !== "ready" || health.database !== "executive-visuals-staging" || health.r2Enabled !== false) {
      throw new Error("The D1 staging service did not return the expected isolated, metadata-only health contract.");
    }
    const result = await apiRequest<{ projects: D1Project[] }>("/api/d1/projects?limit=50");
    state.projects = Array.isArray(result.projects) ? result.projects : [];
    state.ready = true;
    state.checked = true;
    if (!state.projects.some(project => project.id === state.projectId)) state.projectId = state.projects[0]?.id || "";
    if (state.projectId) await loadProjectData(state.projectId);
    else { state.workspace = null; state.assets = []; }
    state.message = "Connected to isolated D1 staging. Production projects, uploads and media storage are unchanged.";
  } catch (error) {
    state.ready = false;
    state.checked = true;
    state.projects = [];
    state.projectId = "";
    state.workspace = null;
    state.assets = [];
    state.message = error instanceof Error ? error.message : "The staging bridge is unavailable.";
  } finally {
    state.busy = false;
    repaint();
  }
}

function projectMarkup() {
  if (!state.ready) return "";
  return '<div class="two-col"><section><div class="eyebrow">STAGING PROJECTS</div><form id="d1-staging-project-form"><label>Project name</label><input name="name" maxlength="160" required placeholder="Staging production"><label>Description</label><textarea name="description" rows="2" maxlength="4000" placeholder="Isolated test workspace"></textarea><button class="primary" type="submit" '+(state.busy ? "disabled" : "")+'>＋ Create staging project</button></form><label class="field-label" for="d1-staging-project-select">Select staging project</label><select id="d1-staging-project-select"><option value="">Choose a project</option>'+state.projects.map(project => '<option value="'+esc(project.id)+'" '+(project.id === state.projectId ? "selected" : "")+'>'+esc(project.name)+' · r'+project.revision+'</option>').join("")+'</select><small class="muted">'+state.projects.length+' staging projects · max 50 per page</small></section><section><div class="eyebrow">REVISIONED WORKSPACE DOCUMENT</div>'+(state.workspace ? '<form id="d1-staging-workspace-form"><label>JSON document · revision '+state.workspace.revision+'</label><textarea name="document" rows="9" spellcheck="false" required>'+esc(JSON.stringify(state.workspace.document, null, 2))+'</textarea><button class="secondary" type="submit" '+(state.busy ? "disabled" : "")+'>Save staging workspace revision</button></form><small class="muted">Optimistic revision checks · 256 KB maximum · conflicts are surfaced, never overwritten.</small>' : '<div class="empty">Create or select a staging project to load its workspace document.</div>')+'</section></div><div class="section-title"><div><div class="eyebrow">ASSET METADATA</div><h3>Private asset register · metadata only</h3></div><span>'+state.assets.length+' records</span></div>'+(state.assets.length ? '<div class="project-grid compact">'+state.assets.map(asset => '<article class="project"><b>'+esc(asset.name)+'</b><small>'+esc(asset.mediaType)+' · '+formatBytes(asset.size)+'</small><code>'+esc(asset.sha256.slice(0,16))+'…</code><small>'+esc(asset.createdAt)+'</small></article>').join("")+'</div>' : '<div class="empty">No staging assets registered for this project. Uploads and R2 object storage are deliberately not enabled in this milestone.</div>');
}

export function renderD1StagingWorkspace() {
  return '<section class="panel d1-staging-workspace"><div class="runtime-section-heading"><div><div class="eyebrow">ISOLATED DATABASE PREVIEW</div><h2>D1 staging workspace</h2></div><span class="status">'+(state.ready ? "Connected · staging only" : state.checked ? "Unavailable" : "Not connected")+'</span></div><p>Exercise persistent staging projects, revision-checked workspace documents and private asset metadata without switching production data or enabling media storage.</p><div class="notice">'+esc(state.message)+'</div><div class="action-row"><button class="secondary" data-d1-staging-refresh '+(state.busy ? "disabled" : "")+'>'+ (state.busy ? "Checking…" : state.checked ? "↻ Check staging bridge" : "Connect staging preview")+'</button><small class="muted">No production writes · no media bytes · R2 disabled</small></div>'+projectMarkup()+'</section>';
}

export function initD1StagingWorkspace(onRender: () => void) {
  repaint = onRender;
  if (initialized) return;
  initialized = true;
  document.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-d1-staging-refresh]")) { void refresh(); }
  });
  document.addEventListener("change", event => {
    const target = event.target as HTMLSelectElement;
    if (target.id !== "d1-staging-project-select" || !target.value || state.busy) return;
    state.busy = true;
    state.message = "Loading the selected staging project…";
    repaint();
    void loadProjectData(target.value).then(() => {
      state.message = "Staging project and asset metadata loaded.";
    }).catch(error => {
      state.message = error instanceof Error ? error.message : "The staging project could not be loaded.";
    }).finally(() => {
      state.busy = false;
      repaint();
    });
  });
  document.addEventListener("submit", event => {
    const form = event.target as HTMLFormElement;
    if (form.id === "d1-staging-project-form") {
      event.preventDefault();
      if (!state.ready || state.busy || !form.reportValidity()) return;
      const data = new FormData(form);
      const name = String(data.get("name") || "").trim();
      const description = String(data.get("description") || "");
      state.busy = true;
      state.message = "Creating an isolated staging project…";
      repaint();
      void apiRequest<{ project: D1Project }>("/api/d1/projects", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, description })
      }).then(async result => {
        const list = await apiRequest<{ projects: D1Project[] }>("/api/d1/projects?limit=50");
        state.projects = Array.isArray(list.projects) ? list.projects : [];
        await loadProjectData(result.project.id);
        state.message = "Staging project created with its initial workspace document.";
      }).catch(error => {
        state.message = error instanceof Error ? error.message : "Staging project creation failed.";
      }).finally(() => {
        state.busy = false;
        repaint();
      });
      return;
    }
    if (form.id === "d1-staging-workspace-form") {
      event.preventDefault();
      if (!state.ready || state.busy || !state.workspace || !form.reportValidity()) return;
      const raw = String(new FormData(form).get("document") || "");
      const projectId = state.projectId;
      const expectedRevision = state.workspace.revision;
      let payload: string;
      try { payload = buildD1WorkspaceUpdatePayload(raw, expectedRevision); }
      catch (error) { state.message = error instanceof Error ? error.message : "Workspace JSON is invalid."; repaint(); return; }
      state.busy = true;
      state.message = "Saving a revision-checked staging workspace…";
      repaint();
      void apiRequest<D1Workspace>("/api/d1/projects/" + encodeURIComponent(projectId) + "/workspace", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: payload
      }).then(result => {
        state.workspace = result;
        state.message = "Workspace saved as revision "+result.revision+".";
      }).catch(error => {
        state.message = error instanceof Error ? error.message : "Workspace save failed. Refresh to reconcile the latest revision.";
      }).finally(() => {
        state.busy = false;
        repaint();
      });
    }
  });
}
