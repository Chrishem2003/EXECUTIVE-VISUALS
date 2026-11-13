import { createD1Repository } from "../server/d1-repository.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body, status = 200, headers = {}) {
  const output = new Headers(headers);
  output.set("content-type", "application/json; charset=utf-8");
  output.set("cache-control", "no-store");
  output.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers: output });
}

function responseCookies(response) {
  if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie();
  const cookie = response.headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

function withCookies(response, cookies = []) {
  if (!cookies.length) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withCors(response, request, env) {
  const requestOrigin = request.headers.get("origin");
  if (!requestOrigin || !env.APP_ORIGIN) return response;
  let allowedOrigin = "";
  try {
    const configured = new URL(env.APP_ORIGIN);
    if (configured.protocol === "https:" && configured.origin === env.APP_ORIGIN) allowedOrigin = configured.origin;
  } catch {}
  if (!allowedOrigin || requestOrigin !== allowedOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", allowedOrigin);
  headers.set("access-control-allow-methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "authorization,content-type");
  headers.set("access-control-max-age", "600");
  headers.append("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function safeApiOrigin(value) {
  const origin = new URL(value);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("API_ORIGIN must be a plain HTTPS origin.");
  }
  return origin;
}

function errorResponse(error) {
  if (isD1QuotaError(error)) {
    return json({ error: {
      code: "D1_QUOTA_EXCEEDED",
      message: "The staging database daily quota has been reached. Access will resume after the UTC daily reset; stored data is unchanged."
    } }, 503);
  }
  const status = error?.status || (error?.code === "D1_PROJECT_NOT_FOUND" ? 404
    : error?.code === "D1_PROJECT_ACCESS_DENIED" ? 403
    : error?.code === "D1_PROJECT_REVISION_CONFLICT" || error?.code === "D1_MEMBER_AMBIGUOUS" ? 409
    : error?.code === "D1_MEMBER_NOT_FOUND" ? 404
    : 400);
  return json({ error: { code: error?.code || "D1_REQUEST_INVALID", message: String(error?.message || "The D1 request could not be completed.").slice(0, 300) } }, status);
}

async function readJson(request, maxBytes = 32 * 1024) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) throw Object.assign(new Error("Request body is too large."), { status: 413, code: "BODY_TOO_LARGE" });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw Object.assign(new Error("Request body is too large."), { status: 413, code: "BODY_TOO_LARGE" });
  try {
    const value = JSON.parse(raw || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON body must be an object.");
    return value;
  } catch {
    throw Object.assign(new Error("Request body must be a JSON object."), { status: 400, code: "INVALID_JSON" });
  }
}

async function authenticate(request, env) {
  const apiOrigin = safeApiOrigin(env.API_ORIGIN);
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  if (cookie) headers.set("cookie", cookie);
  if (authorization) headers.set("authorization", authorization);
  headers.set("origin", apiOrigin.origin);
  headers.set("accept", "application/json");
  let response;
  try {
    response = await fetch(new Request(new URL("/api/me", apiOrigin), { method: "GET", headers, redirect: "manual" }));
  } catch {
    throw Object.assign(new Error("The application identity service is unavailable."), { status: 502, code: "IDENTITY_SERVICE_UNAVAILABLE" });
  }
  const sessionCookies = responseCookies(response);
  if (response.status >= 300 && response.status < 400) {
    throw Object.assign(new Error("Sign in to access the staging workspace."), { status: 401, code: "AUTH_REQUIRED", setCookies: sessionCookies });
  }
  if (response.status === 401 || response.status === 403) {
    throw Object.assign(new Error("Sign in to access the staging workspace."), { status: 401, code: "AUTH_REQUIRED", setCookies: sessionCookies });
  }
  if (!response.ok) throw Object.assign(new Error("The application identity service rejected the request."), { status: 502, code: "IDENTITY_SERVICE_UNAVAILABLE", setCookies: sessionCookies });
  let payload;
  try { payload = await response.json(); } catch {
    throw Object.assign(new Error("The application identity service returned an invalid response."), { status: 502, code: "IDENTITY_RESPONSE_INVALID", setCookies: sessionCookies });
  }
  const user = payload?.user;
  if (!user || typeof user.id !== "string" || !UUID.test(user.id)) {
    throw Object.assign(new Error("The authenticated account identity is invalid."), { status: 401, code: "AUTH_REQUIRED", setCookies: sessionCookies });
  }
  const provider = payload.authMode === "supabase" ? "supabase" : payload.authMode === "local" ? "local" : "";
  if (!provider) throw Object.assign(new Error("The account authentication mode is not supported by D1 staging."), { status: 403, code: "AUTH_MODE_UNSUPPORTED", setCookies: sessionCookies });
  return { user: { id: user.id, email: typeof user.email === "string" ? user.email : null, provider }, setCookies: sessionCookies };
}

async function requireSchema(db) {
  const row = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ev_users' LIMIT 1").bind().first();
  return Boolean(row);
}

function isD1QuotaError(error) {
  const messages = [error?.message, error?.cause?.message, error?.cause?.cause?.message]
    .filter(value => typeof value === "string");
  return messages.some(message => /exceeded D1's free tier daily row (?:read|write) limit/i.test(message));
}

async function d1Api(request, env, url) {
  if (!env.DB || typeof env.DB.prepare !== "function") {
    return json({ error: { code: "D1_BINDING_MISSING", message: "The staging D1 binding is not configured." } }, 503);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "allow": "GET,POST,PATCH,PUT,DELETE,OPTIONS", "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS", "access-control-allow-headers": "authorization,content-type", "cache-control": "no-store" } });
  }
  if (url.pathname === "/api/d1/health" && request.method === "GET") {
    const ready = await requireSchema(env.DB);
    return json({ status: ready ? "ready" : "migration_required", database: "executive-visuals-staging", metadataOnly: true, r2Enabled: false }, ready ? 200 : 503);
  }
  if (!await requireSchema(env.DB)) {
    return json({ error: { code: "D1_MIGRATION_REQUIRED", message: "The isolated staging schema has not been applied." } }, 503);
  }
  let user, sessionCookies = [];
  try {
    const authenticated = await authenticate(request, env);
    user = authenticated.user;
    sessionCookies = authenticated.setCookies;
  } catch (error) {
    return withCookies(json({ error: { code: error.code || "AUTH_REQUIRED", message: error.message } }, error.status || 401), error.setCookies);
  }

  const repo = createD1Repository({ db: env.DB, allowR2: false });
  try {
    const principal = await repo.resolvePrincipal({ subject: user.id, provider: user.provider, email: user.email });
    if (url.pathname === "/api/d1/projects" && request.method === "GET") {
      const rawLimit = url.searchParams.get("limit");
      const rawOffset = url.searchParams.get("offset");
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      const offset = rawOffset === null ? 0 : Number(rawOffset);
      const projects = await repo.listProjects({ actorId: principal.id, limit, offset });
      return withCookies(json({ projects, page: { limit, offset }, storage: "cloudflare-d1-staging" }), sessionCookies);
    }
    if (url.pathname === "/api/d1/projects" && request.method === "POST") {
      const body = await readJson(request);
      const project = await repo.createProject({ ownerId: principal.id, name: body.name, description: body.description || "", settings: body.settings || {} });
      return withCookies(json({ project, storage: "cloudflare-d1-staging" }, 201), sessionCookies);
    }

    if (url.pathname === "/api/d1/assets" && request.method === "GET") {
      const rawLimit = url.searchParams.get("limit");
      const rawOffset = url.searchParams.get("offset");
      const limit = rawLimit === null ? 50 : Number(rawLimit);
      const offset = rawOffset === null ? 0 : Number(rawOffset);
      const projectId = url.searchParams.has("projectId") ? url.searchParams.get("projectId") : null;
      const assets = await repo.listAssets({ actorId: principal.id, projectId, limit, offset });
      const visibleAssets = assets.map(asset => ({
        id: asset.id,
        projectId: asset.projectId,
        name: asset.name,
        mediaType: asset.mediaType,
        size: asset.size,
        sha256: asset.sha256,
        derivativeOf: asset.derivativeOf,
        metadata: asset.metadata,
        provenance: asset.provenance,
        createdAt: asset.createdAt
      }));
      return withCookies(json({
        assets: visibleAssets,
        page: { limit, offset },
        storage: "cloudflare-d1-staging",
        metadataOnly: true
      }), sessionCookies);
    }
    const memberCollection = url.pathname.match(/^\/api\/d1\/projects\/([0-9a-f-]{36})\/members$/i);
    if (memberCollection && request.method === "GET") {
      const members = await repo.listMembers({ actorId: principal.id, projectId: memberCollection[1] });
      return withCookies(json({ ...members, projectId: memberCollection[1] }), sessionCookies);
    }
    if (memberCollection && request.method === "POST") {
      const body = await readJson(request);
      const member = await repo.addMemberByEmail({ actorId: principal.id, projectId: memberCollection[1], email: body.email, role: body.role });
      return withCookies(json({ member }, 201), sessionCookies);
    }
    const memberItem = url.pathname.match(/^\/api\/d1\/projects\/([0-9a-f-]{36})\/members\/([0-9a-f-]{36})$/i);
    if (memberItem && request.method === "DELETE") {
      const result = await repo.removeMember({ actorId: principal.id, projectId: memberItem[1], memberId: memberItem[2] });
      return withCookies(json(result), sessionCookies);
    }
    const match = url.pathname.match(/^\/api\/d1\/projects\/([0-9a-f-]{36})$/i);
    if (match && request.method === "GET") {
      const project = await repo.getProject({ actorId: principal.id, projectId: match[1] });
      return withCookies(project ? json({ project, storage: "cloudflare-d1-staging" }) : json({ error: { code: "D1_PROJECT_NOT_FOUND", message: "Project not found." } }, 404), sessionCookies);
    }
    if (match && request.method === "PATCH") {
      const body = await readJson(request);
      const project = await repo.updateProject({ actorId: principal.id, projectId: match[1], expectedRevision: Number(body.expectedRevision ?? body.revision), name: body.name, description: body.description, settings: body.settings });
      return withCookies(json({ project, storage: "cloudflare-d1-staging" }), sessionCookies);
    }
    const workspacePrefix = "/api/d1/projects/";
    const workspaceSuffix = "/workspace";
    const workspaceId = url.pathname.startsWith(workspacePrefix) && url.pathname.endsWith(workspaceSuffix)
      ? url.pathname.slice(workspacePrefix.length, -workspaceSuffix.length)
      : "";
    const workspaceMatch = /^[0-9a-f-]{36}$/i.test(workspaceId) ? [url.pathname, workspaceId] : null;
    if (workspaceMatch && request.method === "GET") {
      const workspace = await repo.getWorkspaceDocument({ actorId: principal.id, projectId: workspaceMatch[1] });
      return withCookies(json(workspace), sessionCookies);
    }
    if (workspaceMatch && request.method === "PUT") {
      const body = await readJson(request, 256 * 1024);
      const workspace = await repo.updateWorkspaceDocument({ actorId: principal.id, projectId: workspaceMatch[1], expectedRevision: Number(body.expectedRevision ?? body.revision), document: body.document });
      return withCookies(json(workspace), sessionCookies);
    }
    return withCookies(json({ error: { code: "D1_ROUTE_NOT_FOUND", message: "D1 staging endpoint not found." } }, 404), sessionCookies);
  } catch (error) {
    return withCookies(errorResponse(error), sessionCookies);
  }
}

async function proxyAuth(request, env) {
  const origin = safeApiOrigin(env.API_ORIGIN);
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, origin);
  const headers = new Headers();
  for (const name of ["cookie", "authorization", "content-type", "accept"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("origin", origin.origin);
  const upstreamRequest = new Request(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    redirect: "manual"
  });
  const upstream = await fetch(upstreamRequest);
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.delete("access-control-allow-origin");
  responseHeaders.delete("access-control-allow-credentials");
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      if (!url.pathname.startsWith("/api/d1/") || !env.APP_ORIGIN || request.headers.get("origin") !== env.APP_ORIGIN) {
        return json({ error: { code: "CORS_ORIGIN_DENIED", message: "This origin is not allowed to access staging APIs." } }, 403);
      }
      return withCors(new Response(null, { status: 204, headers: { "cache-control": "no-store" } }), request, env);
    }
    if (url.pathname === "/edge-health") {
      return withCors(json({ status: "ok", edge: "cloudflare-workers", d1Bound: Boolean(env.DB), apiProxyConfigured: Boolean(env.API_ORIGIN), stagingOnly: true }), request, env);
    }
    if (url.pathname === "/api/d1" || url.pathname.startsWith("/api/d1/")) {
      try { return withCors(await d1Api(request, env, url), request, env); }
      catch (error) { return withCors(json({ error: { code: error.code || "D1_UNAVAILABLE", message: "The staging data service is temporarily unavailable." } }, 503), request, env); }
    }
    const authRoute = (url.pathname === "/api/auth/login" || url.pathname === "/api/auth/logout") && request.method === "POST";
    const identityRoute = url.pathname === "/api/me" && request.method === "GET";
    if (!authRoute && !identityRoute) {
      return withCors(json({ error: { code: "STAGING_ROUTE_NOT_FOUND", message: "This isolated Worker exposes only D1 staging APIs and authentication." } }, 404), request, env);
    }
    try { return withCors(await proxyAuth(request, env), request, env); }
    catch {
      return withCors(json({ error: { code: "IDENTITY_SERVICE_UNAVAILABLE", message: "The application identity service is temporarily unavailable." } }, 502), request, env);
    }
  }
};
