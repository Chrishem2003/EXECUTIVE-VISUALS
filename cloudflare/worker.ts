export interface Env {
  ASSETS: Fetcher;
  API_ORIGIN: string;
}

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  const output = new Headers(headers);
  output.set("content-type", "application/json; charset=utf-8");
  output.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: output });
}

function safeApiOrigin(value: string): URL {
  const origin = new URL(value);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("API_ORIGIN must be a plain HTTPS origin.");
  }
  return origin;
}

async function proxyApi(request: Request, env: Env): Promise<Response> {
  const origin = safeApiOrigin(env.API_ORIGIN);
  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, origin);
  const headers = new Headers(request.headers);

  // The browser talks to this Worker as a same-origin app. Present the
  // trusted origin to the fixed backend so its existing same-origin guard
  // continues to work; never accept a client-supplied upstream URL.
  headers.set("origin", origin.origin);
  headers.set("x-forwarded-host", incoming.host);
  headers.set("x-forwarded-proto", incoming.protocol.slice(0, -1));
  headers.set("cache-control", "no-store");
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");

  const upstreamRequest = new Request(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual"
  });
  const upstream = await fetch(upstreamRequest);
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.delete("access-control-allow-origin");
  responseHeaders.delete("access-control-allow-credentials");

  const location = responseHeaders.get("location");
  if (location) {
    try {
      const redirect = new URL(location);
      if (redirect.origin === origin.origin) {
        responseHeaders.set("location", new URL(redirect.pathname + redirect.search + redirect.hash, incoming.origin).toString());
      }
    } catch {
      // Leave non-URL Location values unchanged.
    }
  }

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/edge-health") {
      return json({ status: "ok", edge: "cloudflare-workers", apiProxyConfigured: Boolean(env.API_ORIGIN) });
    }

    if (url.pathname === "/robots.txt") {
      return new Response(
        `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /assets/\nSitemap: https://${url.host}/sitemap.xml\n`,
        { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } }
      );
    }

    if (url.pathname === "/sitemap.xml") {
      const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${url.host}/</loc></url></urlset>`;
      return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300" } });
    }

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return await proxyApi(request, env);
      } catch {
        return json({ error: { code: "EDGE_UPSTREAM_UNAVAILABLE", message: "The application API is temporarily unavailable. Please retry shortly." } }, 502);
      }
    }

    return env.ASSETS.fetch(request);
  }
} satisfies ExportedHandler<Env>;
