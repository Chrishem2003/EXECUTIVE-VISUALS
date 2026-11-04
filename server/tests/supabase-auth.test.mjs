import test from "node:test";
import assert from "node:assert/strict";
import { createSupabaseAuth, SUPABASE_SESSION_COOKIE } from "../supabase-auth.mjs";

const config = {
  url: "https://project.example.test",
  publishableKey: "public-test-key",
  sessionSecret: "a-long-test-only-session-secret-with-more-than-thirty-two-characters"
};
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" }
});
const tokenPayload = (suffix = "one", expires = 3600) => ({
  access_token: "access-token-" + suffix,
  refresh_token: "refresh-token-" + suffix,
  token_type: "bearer",
  expires_in: expires,
  user: { id: "user-123", email: "creator@example.test" }
});

test("sign-in encrypts access and refresh tokens into an opaque HttpOnly-cookie value", async () => {
  const calls = [];
  const auth = createSupabaseAuth({
    ...config,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return response(tokenPayload());
    }
  });
  const session = await auth.signIn(" Creator@Example.test ", "a-long-password-value");
  assert.equal(session.user.email, "creator@example.test");
  assert.equal(session.maxAge, 30 * 24 * 60 * 60);
  assert.ok(session.cookie.startsWith("v1."));
  assert.equal(session.cookie.includes("access-token-one"), false);
  assert.equal(session.cookie.includes("refresh-token-one"), false);
  assert.equal(calls[0].url, "https://project.example.test/auth/v1/token?grant_type=password");
  assert.equal(calls[0].options.headers.apikey, config.publishableKey);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(SUPABASE_SESSION_COOKIE, "ev_supabase_session");
});

test("session verification uses the access token only on the server", async () => {
  const calls = [];
  const auth = createSupabaseAuth({
    ...config,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("/token?")) return response(tokenPayload());
      return response({ id: "user-123", email: "creator@example.test" });
    }
  });
  const session = await auth.signIn("creator@example.test", "a-long-password-value");
  const verified = await auth.getUser(session.cookie);
  assert.deepEqual(verified.user, { id: "user-123", email: "creator@example.test" });
  assert.equal(verified.cookie, null);
  assert.equal(calls[1].options.headers.authorization, "Bearer access-token-one");
});

test("expired access token rotates the refresh token and returns a replacement cookie", async () => {
  const calls = [];
  const auth = createSupabaseAuth({
    ...config,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return response(tokenPayload(calls.length === 1 ? "old" : "new", calls.length === 1 ? 1 : 3600));
    }
  });
  const session = await auth.signIn("creator@example.test", "a-long-password-value");
  const refreshed = await auth.getUser(session.cookie);
  assert.deepEqual(refreshed.user, { id: "user-123", email: "creator@example.test" });
  assert.ok(refreshed.cookie && refreshed.cookie !== session.cookie);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://project.example.test/auth/v1/token?grant_type=refresh_token");
  assert.deepEqual(JSON.parse(calls[1].options.body), { refresh_token: "refresh-token-old" });
});

test("invalid and tampered session cookies fail closed", async () => {
  const auth = createSupabaseAuth({ ...config, fetchImpl: async () => response({}) });
  assert.equal(await auth.getUser("not-a-session"), null);
  const session = await auth.signIn("creator@example.test", "a-long-password-value");
  const tampered = session.cookie.slice(0, -1) + (session.cookie.endsWith("a") ? "b" : "a");
  assert.equal(await auth.getUser(tampered), null);
});

test("sign-up reports email confirmation without creating an application session", async () => {
  let requested = "";
  const auth = createSupabaseAuth({
    ...config,
    fetchImpl: async (url) => {
      requested = String(url);
      return response({ user: { id: "user-456", email: "new@example.test" }, session: null });
    }
  });
  const result = await auth.signUp("new@example.test", "a-long-password-value");
  assert.equal(requested, "https://project.example.test/auth/v1/signup");
  assert.equal(result.confirmationRequired, true);
  assert.equal(result.cookie, null);
});

test("rejects weak credentials, insecure remote URLs and short session secrets", async () => {
  assert.throws(() => createSupabaseAuth({ ...config, sessionSecret: "short" }), { code: "SUPABASE_AUTH_CONFIG_INVALID" });
  assert.throws(() => createSupabaseAuth({ ...config, url: "http://auth.example.test" }), { code: "SUPABASE_AUTH_CONFIG_INVALID" });
  const auth = createSupabaseAuth({ ...config, fetchImpl: async () => response(tokenPayload()) });
  await assert.rejects(auth.signIn("not-an-email", "a-long-password-value"), { code: "INVALID_CREDENTIALS" });
  await assert.rejects(auth.signIn("creator@example.test", "short"), { code: "INVALID_CREDENTIALS" });
});

test("password recovery uses the configured Supabase Auth endpoint without revealing account existence", async () => {
  let call;
  const auth = createSupabaseAuth({
    ...config,
    fetchImpl: async (url, options) => {
      call = { url: String(url), options };
      return response({});
    }
  });
  assert.equal(await auth.requestPasswordRecovery("Creator@Example.test"), true);
  assert.equal(call.url, "https://project.example.test/auth/v1/recover");
  assert.deepEqual(JSON.parse(call.options.body), { email: "creator@example.test" });
  await assert.rejects(auth.requestPasswordRecovery("not-an-email"), { code: "INVALID_CREDENTIALS" });
});

test("invalid credentials return a generic authentication error", async () => {
  const auth = createSupabaseAuth({
    ...config,
    fetchImpl: async () => response({ msg: "specific internal provider response" }, 400)
  });
  await assert.rejects(auth.signIn("creator@example.test", "a-long-password-value"), error => {
    assert.equal(error.code, "INVALID_CREDENTIALS");
    assert.equal(error.message, "Email or password is incorrect.");
    assert.equal(error.message.includes("specific internal"), false);
    return true;
  });
});
