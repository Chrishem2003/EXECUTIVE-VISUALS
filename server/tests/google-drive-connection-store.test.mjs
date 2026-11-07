import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleDriveConnectionStore } from "../google-drive-connection-store.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
const scopes = ["https://www.googleapis.com/auth/drive.file", "openid", "https://www.googleapis.com/auth/userinfo.email"];
const record = { owner_id: ownerId, google_subject: "google-subject-12345", google_email: "user@example.com",
  encrypted_refresh_token: "gdrive:v1:AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCCCCCC",
  granted_scopes: scopes };
function harness({ responseRows = [record], status = 200 } = {}) {
  const calls = [];
  const store = createGoogleDriveConnectionStore({
    url: "https://example.supabase.co", serviceRoleKey: "service-role-secret-123456789",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(status === 204 ? null : JSON.stringify(responseRows), { status });
    }
  });
  return { store, calls };
}
test("reads only the authenticated owner's encrypted Google connection", async () => {
  const h = harness();
  const result = await h.store.get(ownerId);
  assert.equal(result.ownerId, ownerId);
  assert.equal(result.encryptedRefreshToken, record.encrypted_refresh_token);
  assert.equal(h.calls[0].options.headers["accept-profile"], "executive_visuals");
  assert.match(h.calls[0].url, /owner_id=eq\./);
});
test("upserts encrypted connection metadata without exposing plaintext tokens", async () => {
  const h = harness();
  const result = await h.store.upsert({ ownerId, googleSubject: record.google_subject, email: record.google_email,
    encryptedRefreshToken: record.encrypted_refresh_token, grantedScopes: scopes });
  assert.equal(result.ownerId, ownerId);
  assert.equal(h.calls[0].options.method, "POST");
  assert.equal(h.calls[0].options.headers.prefer, "resolution=merge-duplicates,return=representation");
  assert.equal(h.calls[0].options.body.includes("refresh-token"), false);
});
test("deletes only the specified owner's connection", async () => {
  const h = harness({ responseRows: [], status: 204 });
  assert.equal(await h.store.delete(ownerId), true);
  assert.equal(h.calls[0].options.method, "DELETE");
  assert.match(h.calls[0].url, /owner_id=eq\./);
});
test("rejects malformed owners and plaintext token values", async () => {
  const h = harness();
  await assert.rejects(() => h.store.get("bad"), error => error.code === "GOOGLE_CONNECTION_STORE_OWNER_INVALID");
  await assert.rejects(() => h.store.upsert({ ownerId, googleSubject: record.google_subject, email: record.google_email,
    encryptedRefreshToken: "plain-refresh-token", grantedScopes: scopes }),
    error => error.code === "GOOGLE_CONNECTION_STORE_RECORD_INVALID");
});
test("fails closed on service errors and invalid records", async () => {
  const failed = harness({ status: 503 });
  await assert.rejects(() => failed.store.get(ownerId), error => error.code === "GOOGLE_CONNECTION_STORE_WRITE_FAILED");
  const invalid = harness({ responseRows: [{ ...record, encrypted_refresh_token: "plaintext" }] });
  await assert.rejects(() => invalid.store.get(ownerId), error => error.code === "GOOGLE_CONNECTION_STORE_RESPONSE_INVALID");
});
