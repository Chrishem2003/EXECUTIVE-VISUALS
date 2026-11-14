export function evaluateLocalAssetUploadPolicy({nodeEnv,dataDirPersistence,requirePersistentDataDir}) {
  if (nodeEnv !== "production") return { allowed: true, code: null, message: null };
  if (dataDirPersistence === "operator-confirmed-volume" && requirePersistentDataDir === true) {
    return { allowed: true, code: null, message: null };
  }
  return {
    allowed: false,
    code: "PERSISTENT_STORAGE_REQUIRED",
    message: "Local asset uploads are disabled because this production runtime does not have an operator-confirmed persistent data volume. Configure and verify persistent storage, or use the private cloud media workspace."
  };
}
