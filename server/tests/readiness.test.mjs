import test from "node:test";
import assert from "node:assert/strict";
import { evaluateReadiness } from "../readiness.mjs";

test("development readiness does not require hosted-only infrastructure", () => {
  assert.deepEqual(evaluateReadiness({ nodeEnv:"development", authMode:"local" }), {
    ready:true, status:"ready", checks:[]
  });
});

test("production readiness fails closed when hosted identity, private media or durable volume is missing", () => {
  const result=evaluateReadiness({
    nodeEnv:"production", authMode:"local",
    requirePersistentDataDir:false, dataDirExists:false,
    databaseWithinDataDir:false, mediaWithinDataDir:false,
    dataDirPersistence:"ephemeral"
  });
  assert.equal(result.ready,false);
  assert.deepEqual(result.checks.map(check=>check.id),[
    "external-auth-mode","server-managed-session","private-media-lifecycle","persistent-volume"
  ]);
  assert.ok(result.checks.every(check=>check.status==="blocked"));
  assert.equal(JSON.stringify(result).includes("/mnt/"),false);
});

test("private media readiness passes only with verified Supabase auth and private storage", () => {
  const result=evaluateReadiness({
    nodeEnv:"production", authMode:"supabase", serverManagedSessionsReady:true,
    cloudTimelineApiEnabled:true, cloudTimelineStorageReady:true,
    requirePersistentDataDir:true, dataDirExists:true,
    databaseWithinDataDir:true, mediaWithinDataDir:true,
    dataDirPersistence:"operator-confirmed-volume",
    supabaseUrl:"https://project.example.test",
    supabasePublishableKey:"public-key", supabaseServiceRoleKey:"server-only-key"
  });
  assert.equal(result.checks.find(check=>check.id==="private-media-lifecycle").status,"passed");
  assert.equal(result.checks.find(check=>check.id==="cloud-timeline-private-storage").status,"passed");
  assert.equal(JSON.stringify(result).includes("server-only-key"),false);
});

test("cloud media readiness rejects unsafe URLs and missing credentials", () => {
  const result=evaluateReadiness({
    nodeEnv:"development", authMode:"supabase", cloudTimelineApiEnabled:true,
    cloudTimelineStorageReady:false, supabaseUrl:"http://example.test",
    supabasePublishableKey:"", supabaseServiceRoleKey:"secret"
  });
  assert.equal(result.ready,false);
  assert.equal(result.checks.find(check=>check.id==="cloud-timeline-credentials").status,"blocked");
  assert.equal(result.checks.find(check=>check.id==="cloud-timeline-private-storage").status,"blocked");
  assert.equal(JSON.stringify(result).includes("secret"),false);
});

test("enabled AI gateways must be configured before readiness passes", () => {
  const result=evaluateReadiness({
    nodeEnv:"development", imageGatewayEnabled:true, imageGatewayConfigured:false,
    textGatewayEnabled:true, textGatewayConfigured:true
  });
  assert.equal(result.ready,false);
  assert.equal(result.checks.find(check=>check.id==="image-gateway").status,"blocked");
  assert.equal(result.checks.find(check=>check.id==="text-gateway").status,"passed");
});

test("a configured cloud timeline can pass configuration checks outside production", () => {
  const result=evaluateReadiness({
    nodeEnv:"development", authMode:"supabase", cloudTimelineApiEnabled:true,
    cloudTimelineStorageReady:true, supabaseUrl:"https://project.example.test",
    supabasePublishableKey:"public-key", supabaseServiceRoleKey:"server-only-key"
  });
  assert.equal(result.ready,true);
  assert.ok(result.checks.every(check=>check.status==="passed"));
});
