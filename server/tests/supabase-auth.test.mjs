import test from "node:test";
import assert from "node:assert/strict";
import { verifySupabaseUser } from "../supabase-auth.mjs";

test("Supabase identity verification sends only the publishable key and bearer token", async () => {
  let observed;
  const user = await verifySupabaseUser({
    supabaseUrl: "https://project.example/",
    publishableKey: "sb_publishable_test",
    accessToken: "test-access-token",
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return { ok: true, json: async () => ({ id: "user-123", email: "person@example.test" }) };
    }
  });
  assert.deepEqual(user, { id: "user-123", email: "person@example.test" });
  assert.equal(observed.url, "https://project.example/auth/v1/user");
  assert.equal(observed.options.method, "GET");
  assert.equal(observed.options.headers.apikey, "sb_publishable_test");
  assert.equal(observed.options.headers.authorization, "Bearer test-access-token");
  assert.ok(observed.options.signal instanceof AbortSignal);
});

test("Supabase identity verification fails closed for rejected or malformed responses", async () => {
  const rejected = await verifySupabaseUser({
    supabaseUrl: "https://project.example",
    publishableKey: "public",
    accessToken: "token",
    fetchImpl: async () => ({ ok: false, status: 401 })
  });
  assert.equal(rejected, null);

  const malformed = await verifySupabaseUser({
    supabaseUrl: "https://project.example",
    publishableKey: "public",
    accessToken: "token",
    fetchImpl: async () => ({ ok: true, json: async () => ({ email: "missing-id@example.test" }) })
  });
  assert.equal(malformed, null);
});

test("Supabase identity verification applies a bounded abort timeout and fails closed", async () => {
  let observedSignal;
  const started = Date.now();
  const user = await verifySupabaseUser({
    supabaseUrl: "https://project.example",
    publishableKey: "public",
    accessToken: "token",
    timeoutMs: 100,
    fetchImpl: (_url, options) => new Promise((resolve, reject) => {
      observedSignal = options.signal;
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    })
  });
  assert.equal(user, null);
  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - started < 2000, "verification should stop promptly after its timeout");
});

test("Supabase identity verification rejects missing credentials and unsafe URLs without network calls", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ id: "user-1" }) }; };
  assert.equal(await verifySupabaseUser({ supabaseUrl: "https://project.example", publishableKey: "", accessToken: "token", fetchImpl }), null);
  assert.equal(await verifySupabaseUser({ supabaseUrl: "file:///etc/passwd", publishableKey: "public", accessToken: "token", fetchImpl }), null);
  assert.equal(await verifySupabaseUser({ supabaseUrl: "https://project.example", publishableKey: "public", accessToken: "x".repeat(16385), fetchImpl }), null);
  assert.equal(calls, 0);
});
