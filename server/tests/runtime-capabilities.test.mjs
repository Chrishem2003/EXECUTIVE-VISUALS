import test from "node:test";
import assert from "node:assert/strict";
import { describeRuntimeCapabilities } from "../../src/platform/runtime-capabilities.ts";

const byId = (items, id) => items.find(item => item.id === id);

test("hosted account sessions require encrypted server-side token storage", () => {
  const items = describeRuntimeCapabilities({ authMode: "supabase", authSessionReady: true, authSessionEncrypted: false });
  assert.equal(byId(items, "account-session").state, "blocked");
  assert.match(byId(items, "account-session").detail, /incomplete/i);
});

test("cloud media jobs are not reported ready when the jobs API is disabled", () => {
  const items = describeRuntimeCapabilities({ cloudMediaReady: true, cloudMediaJobsEnabled: false });
  assert.equal(byId(items, "cloud-media").state, "limited");
});

test("AI gateways require both explicit enablement and complete configuration", () => {
  const items = describeRuntimeCapabilities({ textGatewayEnabled: true, textGatewayConfigured: false, imageGatewayEnabled: false, imageGatewayConfigured: true });
  assert.equal(byId(items, "text-gateway").state, "blocked");
  assert.equal(byId(items, "image-gateway").state, "disabled");
});

test("media engine reports partial FFmpeg readiness honestly", () => {
  const items = describeRuntimeCapabilities({ ffmpeg: false, ffprobe: true });
  assert.equal(byId(items, "media-engine").state, "limited");
});

test("billing is ready only when provider credentials and webhook verification are configured", () => {
  const incomplete = describeRuntimeCapabilities({ billingEnabled: true, billingProviderConfigured: true, billingWebhookConfigured: false });
  assert.equal(byId(incomplete, "billing").state, "blocked");
  const complete = describeRuntimeCapabilities({ billingEnabled: true, billingProviderConfigured: true, billingWebhookConfigured: true, billingProviderMode: "sandbox" });
  assert.equal(byId(complete, "billing").state, "ready");
  assert.match(byId(complete, "billing").detail, /sandbox provider/i);
});

test("disabled gateways and local auth never imply production readiness", () => {
  const items = describeRuntimeCapabilities({ authMode: "local", textGatewayEnabled: false, imageGatewayEnabled: false, billingEnabled: false });
  assert.equal(byId(items, "account-session").state, "limited");
  assert.equal(byId(items, "text-gateway").state, "disabled");
  assert.equal(byId(items, "image-gateway").state, "disabled");
  assert.equal(byId(items, "billing").state, "disabled");
});
