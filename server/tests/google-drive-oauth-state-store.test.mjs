import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleDriveOAuthStateStore } from "../google-drive-connection-store.mjs";

const ownerId = "11111111-1111-4111-8111-111111111111";
function harness({ responseRows = [{ owner_id: ownerId, encrypted_payload: "gstate:v1:AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCCCCCC",
  expires_at: new Date(Date.now() + 60000).toISOString() }] } = {}) {
  const calls = [];
  const store = createGoogleDriveOAuthStateStore({
    url: "https://example.supabase.co", serviceRoleKey: "service-role-secret-123456789",
    encryptionKey: "test-encryption-key-with-more-than-thirty-two-characters",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (options.method === "POST") return new Response(JSON.stringify([{ state_hash: "a".repeat(64) }]), { status: 201 });
      return new Response(JSON.stringify(responseRows), { status: 200 });
    }
  });
  return { store, calls };
}
test("stores only a state hash and an encrypted PKCE verifier/nonce payload", async () => {
  const h = harness();
  const state = "s".repeat(43), verifier = "v".repeat(64), nonce = "n".repeat(43);
  await h.store.put(state, { ownerId, verifier, nonce, expiresAt: Date.now() + 60000 });
  const body = JSON.parse(h.calls[0].options.body);
  assert.equal(body.owner_id, ownerId);
  assert.equal(body.state_hash.length, 64);
  assert.notEqual(body.state_hash, state);
  assert.match(body.encrypted_payload, /^gstate:v1:/);
  assert.equal(body.encrypted_payload.includes(verifier), false);
  assert.equal(body.encrypted_payload.includes(nonce), false);
  assert.equal(h.calls[0].options.headers["content-profile"], "executive_visuals");
});
test("consumes OAuth state with one atomic delete operation", async () => {
  const h = harness({ responseRows: [] });
  assert.equal(await h.store.consume("s".repeat(43)), null);
  assert.equal(h.calls[0].options.method, "DELETE");
  assert.match(h.calls[0].url, /state_hash=eq\./);
});
test("rejects malformed or overlong state payloads before persistence", async () => {
  const h = harness();
  await assert.rejects(() => h.store.put("short", { ownerId, verifier: "x", nonce: "y", expiresAt: Date.now() + 1000 }));
  assert.equal(h.calls.length, 0);
});
