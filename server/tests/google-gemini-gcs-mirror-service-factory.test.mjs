import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleGeminiGcsMirrorServiceFactory } from "../google-gemini-gcs-mirror-service-factory.mjs";

const encryptionKey=Buffer.alloc(32,9).toString("base64");
const env={
  GOOGLE_CLOUD_PROJECT_ID:"test-gcp-project-12345",
  GEMINI_GCS_ALLOWED_BUCKETS:"private-media-bucket",
  GEMINI_GCS_MIRROR_BUCKET:"private-media-bucket",
  GEMINI_GCS_SESSION_ENCRYPTION_KEY:encryptionKey
};
const sourceRepository={
  async findActiveSource(){return null;},
  async recordVerifiedSource(value){return value;},
  async revokeSource(){return {state:"REVOKED"};}
};
const dependencies={
  url:"https://project.supabase.co",
  serviceRoleKey:"server-only-service-role-test",
  env,
  fetchImpl:async()=>{throw new Error("network must not be used during construction");},
  sourceRepository,
  authorizePrivateAsset:async()=>({}),
  loadPrivateAsset:async()=>({}),
};

test("requires an explicit server-side Google Cloud token provider",()=>{
  assert.throws(()=>createGoogleGeminiGcsMirrorServiceFactory(),/explicit server-side Google Cloud token provider/);
});

test("builds a GCS mirror service with encrypted durable attempts and injected identity",()=>{
  const tokenProvider=async()=> "server-only-google-token-123456";
  const createService=createGoogleGeminiGcsMirrorServiceFactory({
    getAccessToken:tokenProvider,serviceDependencies:dependencies
  });
  const service=createService({});
  assert.equal(typeof service.mirrorAsset,"function");
  assert.equal(typeof service.recoverMirrorAttempts,"function");
  assert.equal(typeof service.revokeSource,"function");
});

test("fails closed when the server-side session encryption key is missing",()=>{
  const createService=createGoogleGeminiGcsMirrorServiceFactory({
    getAccessToken:async()=> "server-only-google-token-123456",
    serviceDependencies:{...dependencies,env:{...env,GEMINI_GCS_SESSION_ENCRYPTION_KEY:undefined}}
  });
  assert.throws(()=>createService({}),/encryption key/);
});
