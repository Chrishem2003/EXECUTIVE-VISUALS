import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createNeonObjectStorage } from "../server/neon-object-storage.mjs";

const MIME = "text/plain";
const FIXTURE = Buffer.from("Executive Visuals isolated Neon storage acceptance fixture v1\n");

export async function runNeonStorageRoundtrip({
  storage,
  fetchImpl = globalThis.fetch,
  fixture = FIXTURE
} = {}) {
  if (!storage || typeof storage.checkReadiness !== "function" ||
      typeof storage.upload !== "function" || typeof storage.verifyObject !== "function" ||
      typeof storage.createSignedUrl !== "function" || typeof storage.remove !== "function") {
    throw new Error("A complete Neon Object Storage adapter is required.");
  }
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  if (!(fixture instanceof Uint8Array) || fixture.byteLength < 1) {
    throw new Error("The storage acceptance fixture must contain bytes.");
  }

  const ownerScope = randomUUID();
  const objectPath = ownerScope + "/acceptance-" + randomUUID() + "/roundtrip.txt";
  const sha256 = createHash("sha256").update(fixture).digest("hex");
  let uploaded = false;
  let primaryError = null;
  let receipt = null;

  try {
    const readiness = await storage.checkReadiness();
    if (readiness?.ready !== true || readiness?.storage !== "private") {
      throw new Error("Neon storage readiness did not confirm a private bucket.");
    }
    const upload = await storage.upload(objectPath, fixture, MIME);
    uploaded = true;
    if (upload.path !== objectPath || upload.size !== fixture.byteLength) {
      throw new Error("Neon upload receipt does not match the acceptance fixture.");
    }

    const verified = await storage.verifyObject(objectPath, {
      expectedSize: fixture.byteLength,
      expectedSha256: sha256,
      contentType: MIME
    });
    if (verified.sha256 !== sha256 || verified.size !== fixture.byteLength) {
      throw new Error("Authenticated read-back did not match the uploaded fixture.");
    }

    const signedUrl = await storage.createSignedUrl(objectPath, 120);
    const parsed = new URL(signedUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
        parsed.searchParams.get("X-Amz-Expires") !== "120") {
      throw new Error("Neon returned an invalid or unsafe short-lived download URL.");
    }
    const response = await fetchImpl(signedUrl, { method: "GET", redirect: "error" });
    if (!response.ok) throw new Error("Presigned download failed (HTTP " + response.status + ").");
    const downloaded = new Uint8Array(await response.arrayBuffer());
    const downloadHash = createHash("sha256").update(downloaded).digest("hex");
    if (downloaded.byteLength !== fixture.byteLength || downloadHash !== sha256) {
      throw new Error("Presigned download bytes do not match the uploaded fixture.");
    }
    receipt = Object.freeze({
      ready: true,
      provider: "neon-object-storage",
      privacy: "private",
      uploadVerified: true,
      authenticatedReadVerified: true,
      presignedDownloadVerified: true,
      checksumVerified: true,
      cleanupPending: true
    });
  } catch (error) {
    primaryError = error;
  }

  let cleanupError = null;
  if (uploaded) {
    try { await storage.remove(objectPath); }
    catch (error) { cleanupError = error; }
  }

  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], "Neon storage acceptance failed and cleanup also failed.");
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw new Error("Neon storage acceptance passed but its temporary object could not be deleted.");
  return Object.freeze({ ...receipt, cleanupPending: false, cleanupVerified: true });
}

async function main() {
  const required = [
    "NEON_STORAGE_ENDPOINT", "NEON_STORAGE_REGION",
    "NEON_STORAGE_ACCESS_KEY_ID", "NEON_STORAGE_SECRET_ACCESS_KEY"
  ];
  const missing = required.filter(name => !String(process.env[name] || "").trim());
  if (missing.length) {
    throw new Error("Missing required Neon storage settings: " + missing.join(", "));
  }
  const storage = createNeonObjectStorage({
    endpoint: process.env.NEON_STORAGE_ENDPOINT,
    region: process.env.NEON_STORAGE_REGION,
    accessKeyId: process.env.NEON_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.NEON_STORAGE_SECRET_ACCESS_KEY,
    bucket: process.env.NEON_STORAGE_BUCKET || "executive-visuals-media",
    maxBytes: 1024 * 1024
  });
  const result = await runNeonStorageRoundtrip({ storage });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write("Neon storage acceptance failed: " + String(error?.message || error) + "\n");
    process.exitCode = 1;
  });
}
