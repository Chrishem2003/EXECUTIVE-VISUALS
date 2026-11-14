import assert from "node:assert/strict";
import test from "node:test";
import worker from "./production-worker.mjs";

const edgeUrl = "https://executive-visuals.chrishem.workers.dev";
const apiOrigin = "https://executive-visuals.onrender.com";

test("edge health reports the API proxy configuration state", async () => {
  const response = await worker.fetch(new Request(`${edgeUrl}/edge-health`), {
    API_ORIGIN: apiOrigin
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    edge: "cloudflare-workers",
    apiProxyConfigured: true
  });
});

test("API requests preserve method and body and rewrite same-origin redirects", async t => {
  let captured;
  t.mock.method(globalThis, "fetch", async request => {
    captured = request;
    return new Response("redirecting", {
      status: 302,
      headers: {
        location: `${apiOrigin}/auth/login?next=%2Fstudio`,
        "access-control-allow-origin": "*",
        "access-control-allow-credentials": "true"
      }
    });
  });

  const response = await worker.fetch(new Request(`${edgeUrl}/api/projects?limit=3`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
      origin: edgeUrl
    },
    body: JSON.stringify({ name: "Production test" })
  }), { API_ORIGIN: apiOrigin });

  assert.equal(captured.url, `${apiOrigin}/api/projects?limit=3`);
  assert.equal(captured.method, "POST");
  assert.equal(captured.headers.get("origin"), apiOrigin);
  assert.equal(captured.headers.get("x-forwarded-host"), "executive-visuals.chrishem.workers.dev");
  assert.equal(captured.headers.get("x-forwarded-proto"), "https");
  assert.equal(await captured.text(), JSON.stringify({ name: "Production test" }));
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${edgeUrl}/auth/login?next=%2Fstudio`);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
});

test("API requests fail closed with a clear 502 when the upstream is unavailable", async t => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("upstream offline");
  });
  const response = await worker.fetch(new Request(`${edgeUrl}/api/health`), {
    API_ORIGIN: apiOrigin
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "EDGE_UPSTREAM_UNAVAILABLE");
});

test("missing API origin returns a bounded upstream error instead of crashing", async () => {
  const response = await worker.fetch(new Request(`${edgeUrl}/api/health`), {});
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "EDGE_UPSTREAM_UNAVAILABLE");
});

test("non-API requests are delegated to the static asset binding", async () => {
  let requested;
  const response = await worker.fetch(new Request(edgeUrl), {
    ASSETS: {
      async fetch(request) {
        requested = request.url;
        return new Response("studio shell", { status: 200 });
      }
    }
  });
  assert.equal(requested, edgeUrl + "/");
  assert.equal(await response.text(), "studio shell");
});

test("robots and sitemap are served at the edge", async () => {
  const robots = await worker.fetch(new Request(`${edgeUrl}/robots.txt`), {});
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /Disallow: \/api\//);

  const sitemap = await worker.fetch(new Request(`${edgeUrl}/sitemap.xml`), {});
  assert.equal(sitemap.status, 200);
  assert.match(await sitemap.text(), new RegExp(edgeUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
