function json(body, status = 200, headers = {}) {
  const output = new Headers(headers);
  output.set("content-type", "application/json; charset=utf-8");
  output.set("cache-control", "no-store");
  output.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers: output });
}

function safeApiOrigin(value) {
  const origin = new URL(value);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("API_ORIGIN must be a plain HTTPS origin.");
  }
  return origin;
}

async function proxyApi(request, env) {
  const origin = safeApiOrigin(env.API_ORIGIN);
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, origin);
  const headers = new Headers(request.headers);
  headers.set("origin", origin.origin);
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.slice(0, -1));
  headers.set("cache-control", "no-store");
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");

  const init = {
    method: request.method,
    headers,
    redirect: "manual"
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    init.body = request.body;
    // Required by Node's Fetch implementation in tests; supported by Workers.
    init.duplex = "half";
  }

  const upstream = await fetch(new Request(target, init));
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.delete("access-control-allow-origin");
  responseHeaders.delete("access-control-allow-credentials");

  const location = responseHeaders.get("location");
  if (location) {
    try {
      const redirect = new URL(location);
      if (redirect.origin === origin.origin) {
        responseHeaders.set(
          "location",
          new URL(redirect.pathname + redirect.search + redirect.hash, incoming.origin).toString()
        );
      }
    } catch {
      // Preserve relative or non-origin redirects as returned by the application.
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/edge-health") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Use GET or HEAD for edge health." } }, 405, { allow: "GET, HEAD" });
      }

      try {
        const origin = safeApiOrigin(env.API_ORIGIN);
        const upstream = await fetch(new Request(new URL("/api/health", origin), {
          method: "GET",
          headers: { accept: "application/json", "cache-control": "no-store" },
          signal: AbortSignal.timeout(3000)
        }));
        let health = null;
        if (upstream.ok) {
          try { health = await upstream.json(); } catch {}
        }
        const reachable = upstream.ok && health?.status === "ok";
        return json({
          status: reachable ? "ok" : "degraded",
          edge: "cloudflare-workers",
          apiProxyConfigured: true,
          api: {
            reachable,
            httpStatus: upstream.status,
            authMode: typeof health?.authMode === "string" ? health.authMode : null,
            database: typeof health?.database === "string" ? health.database : null,
            storage: typeof health?.storage === "string" ? health.storage : null,
            cloudMediaReady: health?.cloudMedia?.ready === true,
            localAssetUploadsEnabled: health?.localAssetUploads?.enabled === true
          }
        }, reachable ? 200 : 503);
      } catch {
        return json({
          status: "degraded",
          edge: "cloudflare-workers",
          apiProxyConfigured: Boolean(env.API_ORIGIN),
          api: { reachable: false, httpStatus: null, errorCode: "API_UPSTREAM_UNAVAILABLE" }
        }, 503);
      }
    }

    if (url.pathname === "/robots.txt") {
      return new Response(
        `User-agent: *
Allow: /
Disallow: /api/
Disallow: /assets/
Sitemap: https://${url.host}/sitemap.xml
`,
        {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "public, max-age=300"
          }
        }
      );
    }

    if (url.pathname === "/sitemap.xml") {
      const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${url.host}/</loc></url></urlset>`;
      return new Response(body, {
        headers: {
          "content-type": "application/xml; charset=utf-8",
          "cache-control": "public, max-age=300"
        }
      });
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return await proxyApi(request, env);
      } catch {
        return json({
          error: {
            code: "EDGE_UPSTREAM_UNAVAILABLE",
            message: "The application API is temporarily unavailable. Please retry shortly."
          }
        }, 502);
      }
    }

    return env.ASSETS.fetch(request);
  }
};
