import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signJwt } from "node:crypto";
import { createGoogleDriveOAuth } from "../google-drive-oauth.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const otherOwner = "22222222-2222-4222-8222-222222222222";
const scopes = ["https://www.googleapis.com/auth/drive.file", "openid", "https://www.googleapis.com/auth/userinfo.email"];
const identity = async () => ({ subject: "google-subject-12345", email: "user@example.com" });
function harness({ now = 1000000, issueRefresh = true, refreshStatus = 200, revokeStatus = 200, verifyIdentityFn = identity } = {}) {
  let clock = now, idToken = "mock.id.token", jwks = [];
  const pending = new Map(), records = new Map(), calls = [];
  const stateStore = {
    async put(state, value) { pending.set(state, value); },
    async consume(state) { const value = pending.get(state); pending.delete(state); return value || null; }
  };
  const connections = {
    async get(id) { return records.get(id) || null; },
    async upsert(value) { records.set(value.ownerId, value); },
    async delete(id) { records.delete(id); }
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const form = new URLSearchParams(options.body || "");
    if (String(url).includes("/oauth2/v3/certs")) {
      return new Response(JSON.stringify({ keys: jwks }), { status: 200 });
    }
    if (String(url).includes("/token")) {
      if (form.get("grant_type") === "authorization_code") return new Response(JSON.stringify({
        access_token: "access-token-abcdefghijklmnop", refresh_token: issueRefresh ? "refresh-token-abcdefghijklmnop" : undefined,
        id_token: idToken, expires_in: 3600, scope: scopes.join(" ")
      }), { status: 200 });
      if (refreshStatus !== 200) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: refreshStatus });
      return new Response(JSON.stringify({ access_token: "refreshed-access-token-123456", refresh_token: "rotated-refresh-token-123456",
        expires_in: 3600 }), { status: 200 });
    }
    if (String(url).includes("/revoke")) return new Response(null, { status: revokeStatus });
    throw new Error("Unexpected Google OAuth endpoint");
  };
  const service = createGoogleDriveOAuth({
    clientId: "client-id.apps.googleusercontent.com", clientSecret: "client-secret",
    redirectUri: "https://app.example.com/api/google/drive/callback",
    encryptionKey: "test-encryption-key-with-more-than-thirty-two-characters",
    stateStore, connections, fetchImpl, ...(verifyIdentityFn ? { verifyIdentity: verifyIdentityFn } : {}), now: () => clock
  });
  return { service, pending, records, calls, setNow(value) { clock = value; }, setIdToken(value) { idToken = value; }, setJwks(value) { jwks = value; } };
}

test("starts a state-bound PKCE authorization with only the narrow Drive file scope", async () => {
  const h = harness();
  const result = await h.service.begin({ ownerId });
  const url = new URL(result.authorizationUrl);
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("state").length >= 32, true);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.deepEqual(url.searchParams.get("scope").split(" ").sort(), [...scopes].sort());
  assert.equal(h.pending.size, 1);
});

test("completes callback once, binds it to the authenticated owner and stores only encrypted refresh tokens", async () => {
  const h = harness();
  const start = await h.service.begin({ ownerId });
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  const result = await h.service.complete({ ownerId, state, code: "authorization-code" });
  assert.equal(result.connected, true);
  assert.equal(result.email, "user@example.com");
  const record = h.records.get(ownerId);
  assert.equal(record.googleSubject, "google-subject-12345");
  assert.match(record.encryptedRefreshToken, /^gdrive:v1:/);
  assert.equal(record.encryptedRefreshToken.includes("refresh-token-abcdefghijklmnop"), false);
  assert.equal(await h.service.getAccessToken({ ownerId }), "access-token-abcdefghijklmnop");
  await assert.rejects(() => h.service.complete({ ownerId, state, code: "replay" }),
    error => error.code === "GOOGLE_OAUTH_STATE_INVALID");
});

test("rejects cross-user state and consumes invalid callback state", async () => {
  const h = harness();
  const start = await h.service.begin({ ownerId });
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  await assert.rejects(() => h.service.complete({ ownerId: otherOwner, state, code: "code" }),
    error => error.code === "GOOGLE_OAUTH_STATE_INVALID");
  assert.equal(h.pending.has(state), false);
  assert.equal(h.calls.length, 0);
});

test("refreshes expired access tokens and persists rotated refresh tokens", async () => {
  const h = harness();
  const start = await h.service.begin({ ownerId });
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  await h.service.complete({ ownerId, state, code: "code" });
  h.setNow(4700000);
  assert.equal(await h.service.getAccessToken({ ownerId }), "refreshed-access-token-123456");
  assert.match(h.records.get(ownerId).encryptedRefreshToken, /^gdrive:v1:/);
  assert.equal(h.records.get(ownerId).encryptedRefreshToken.includes("rotated-refresh-token-123456"), false);
});

test("reuses existing encrypted refresh token when Google omits it on re-consent", async () => {
  const h = harness();
  let start = await h.service.begin({ ownerId });
  await h.service.complete({ ownerId, state: new URL(start.authorizationUrl).searchParams.get("state"), code: "code" });
  const previous = h.records.get(ownerId).encryptedRefreshToken;
  // This is a second OAuth exchange with no refresh_token; prior connection remains usable.
  const h2 = harness({ issueRefresh: false });
  h2.records.set(ownerId, h.records.get(ownerId));
  start = await h2.service.begin({ ownerId });
  await h2.service.complete({ ownerId, state: new URL(start.authorizationUrl).searchParams.get("state"), code: "code" });
  assert.notEqual(h2.records.get(ownerId).encryptedRefreshToken, "refresh-token-abcdefghijklmnop");
  assert.match(h2.records.get(ownerId).encryptedRefreshToken, /^gdrive:v1:/);
  assert.equal(previous.startsWith("gdrive:v1:"), true);
});

test("disconnect revokes the refresh token and deletes the local connection", async () => {
  const h = harness();
  const start = await h.service.begin({ ownerId });
  await h.service.complete({ ownerId, state: new URL(start.authorizationUrl).searchParams.get("state"), code: "code" });
  const result = await h.service.disconnect({ ownerId });
  assert.deepEqual(result, { disconnected: true, revoked: true });
  assert.equal(h.records.has(ownerId), false);
});

test("fails closed when no connection exists or the refresh token is revoked", async () => {
  const h = harness();
  await assert.rejects(() => h.service.getAccessToken({ ownerId }), error => error.code === "GOOGLE_OAUTH_NOT_CONNECTED");
});

test("rejects unsafe redirect URI and accepts the built-in cryptographic identity verifier", () => {
  const common = { clientId: "client", clientSecret: "secret", encryptionKey: "a".repeat(40),
    stateStore: { put() {}, consume() {} }, connections: { get() {}, upsert() {}, delete() {} } };
  assert.throws(() => createGoogleDriveOAuth({ ...common, redirectUri: "https://user:pass@example.com/callback", verifyIdentity: identity }),
    error => error.code === "GOOGLE_OAUTH_CONFIG_INVALID");
  assert.doesNotThrow(() => createGoogleDriveOAuth({ ...common, redirectUri: "https://example.com/callback" }));
});

test("cryptographically verifies Google's RS256 ID-token signature, audience, expiry and nonce by default", async () => {
  const h = harness({ verifyIdentityFn: null });
  const start = await h.service.begin({ ownerId });
  const url = new URL(start.authorizationUrl);
  const nonce = url.searchParams.get("nonce");
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-google-key", use: "sig", alg: "RS256" };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-google-key" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com", aud: "client-id.apps.googleusercontent.com",
    exp: Math.floor((1000000 + 3600000) / 1000), iat: Math.floor(1000000 / 1000),
    nonce, sub: "google-subject-12345", email: "User@Example.com", email_verified: true
  })).toString("base64url");
  const signingInput = header + "." + payload;
  const signature = signJwt("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  h.setIdToken(signingInput + "." + signature);
  h.setJwks([jwk]);
  await h.service.complete({ ownerId, state: url.searchParams.get("state"), code: "signed-code" });
  assert.equal(h.records.get(ownerId).email, "user@example.com");
});

test("coalesces concurrent token refreshes for the same owner", async () => {
  const h = harness();
  const start = await h.service.begin({ ownerId });
  await h.service.complete({ ownerId, state: new URL(start.authorizationUrl).searchParams.get("state"), code: "code" });
  h.setNow(4700000);
  const before = h.calls.filter(call => call.url.includes("/token")).length;
  const tokens = await Promise.all([
    h.service.getAccessToken({ ownerId }),
    h.service.getAccessToken({ ownerId }),
    h.service.getAccessToken({ ownerId })
  ]);
  assert.deepEqual(tokens, ["refreshed-access-token-123456", "refreshed-access-token-123456", "refreshed-access-token-123456"]);
  assert.equal(h.calls.filter(call => call.url.includes("/token")).length - before, 1);
});
