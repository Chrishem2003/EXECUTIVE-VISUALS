import { createHash, randomUUID } from "node:crypto";
import { createCloudAssetService } from "../server/cloud-asset-service.mjs";

const required = ["SUPABASE_STAGING_URL", "SUPABASE_STAGING_SECRET_KEY", "STORAGE_TEST_OWNER_ID"];
const missing = required.filter(name => !String(process.env[name] || "").trim());
if (missing.length) {
  console.log(JSON.stringify({ status: "BLOCKED", missing }, null, 2));
  process.exitCode = 2;
} else {
  const url = new URL(process.env.SUPABASE_STAGING_URL);
  const approvedHost = "bokxljngydmqrmktofwm.supabase.co";
  if (url.protocol !== "https:" || url.hostname !== approvedHost || url.username || url.password || url.search || url.hash) {
    throw new Error("Staging storage acceptance refused: SUPABASE_STAGING_URL is not the approved staging project.");
  }
  const ownerId = String(process.env.STORAGE_TEST_OWNER_ID).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ownerId)) {
    throw new Error("STORAGE_TEST_OWNER_ID must be a UUID for a disposable staging test account.");
  }

  const bytes = Buffer.from(JSON.stringify({
    purpose: "executive-visuals-private-storage-acceptance",
    nonce: randomUUID(),
    createdAt: new Date().toISOString()
  }));
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  const service = createCloudAssetService({
    url: url.toString(),
    serviceRoleKey: process.env.SUPABASE_STAGING_SECRET_KEY,
    storageProvider: "supabase",
    maxBytes: 1024 * 1024
  });
  let asset = null;
  let cleaned = false;
  try {
    asset = await service.assets.create({
      ownerId,
      projectId: null,
      originalName: "batch-140-private-roundtrip.json",
      mediaType: "application/json",
      bytes,
      metadata: { acceptanceBatch: 140, disposable: true }
    });
    if (asset.size !== bytes.length || asset.sha256 !== expectedHash) {
      throw new Error("Staging asset metadata receipt did not match the uploaded bytes.");
    }

    const signed = await service.assets.createSignedUrl({ ownerId, assetId: asset.id, expiresIn: 60 });
    if (!signed?.url || signed.asset?.id !== asset.id || signed.asset?.ownerId !== ownerId) {
      throw new Error("Owner-scoped private download authorization returned an invalid receipt.");
    }
    const response = await fetch(signed.url, { method: "GET", redirect: "error" });
    if (!response.ok) throw new Error("Private signed download failed with HTTP " + response.status + ".");
    const downloaded = Buffer.from(await response.arrayBuffer());
    const downloadedHash = createHash("sha256").update(downloaded).digest("hex");
    if (downloadedHash !== expectedHash || !downloaded.equals(bytes)) {
      throw new Error("Private storage round-trip bytes or SHA-256 did not match the upload.");
    }

    const otherOwnerId = randomUUID();
    let crossTenantDenied = false;
    try {
      await service.assets.createSignedUrl({ ownerId: otherOwnerId, assetId: asset.id, expiresIn: 60 });
    } catch (error) {
      crossTenantDenied = error?.code === "CLOUD_ASSET_NOT_FOUND" || error?.code === "CLOUD_ASSET_ACCESS_DENIED";
    }
    if (!crossTenantDenied) throw new Error("Cross-tenant private asset signing was not denied.");

    const deletion = await service.assets.softDelete({ ownerId, assetId: asset.id });
    if (deletion?.deleted !== true) throw new Error("Disposable staging asset was not soft-deleted.");
    cleaned = true;
    console.log(JSON.stringify({
      status: "PASSED",
      storageProvider: "supabase-private",
      bucket: "executive-visuals-media",
      uploadBytes: bytes.length,
      sha256Verified: true,
      signedDownloadVerified: true,
      crossTenantSigningDenied: true,
      disposableAssetDeleted: true
    }, null, 2));
  } finally {
    if (asset && !cleaned) {
      try {
        const deletion = await service.assets.softDelete({ ownerId, assetId: asset.id });
        if (deletion?.deleted !== true) console.error("Cleanup did not confirm deletion of the disposable staging asset.");
      } catch {
        console.error("Cleanup failed for the disposable staging asset; inspect the staging asset cleanup ledger.");
      }
    }
  }
}
