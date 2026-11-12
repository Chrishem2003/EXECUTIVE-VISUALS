export type PersistenceReadinessInput = {
  dataDirectory?: "unknown" | "ephemeral" | "unverified" | "operator-confirmed-volume";
  database?: "unknown" | "sqlite" | "postgres";
  storage?: "unknown" | "local-disk" | "object-storage";
};

export function describePersistenceReadiness(input: PersistenceReadinessInput = {}) {
  const dataDirectory = input.dataDirectory || "unknown";
  const database = input.database || "unknown";
  const storage = input.storage || "unknown";
  const details: string[] = [];
  if (database === "sqlite") details.push("Database: application-local SQLite, not a managed PostgreSQL service.");
  else if (database === "unknown") details.push("Database durability has not been verified by the health endpoint.");
  if (storage === "local-disk") details.push("Media: application-local disk, not private object storage.");
  else if (storage === "unknown") details.push("Media storage backend has not been verified by the health endpoint.");

  if (dataDirectory === "ephemeral") {
    return {
      level: "critical" as const,
      title: "This workspace is running on temporary storage",
      message: "A restart or redeploy may remove projects, sessions, uploaded originals and rendered files. Do not keep the only copy of important production media here until persistent storage and backup/restore are verified.",
      details
    };
  }
  if (dataDirectory !== "operator-confirmed-volume") {
    return {
      level: "warning" as const,
      title: "Storage durability has not been confirmed",
      message: "The application has not verified an operator-confirmed persistent volume. Treat hosted projects and media as non-durable and keep independent backups until persistence and restore tests pass.",
      details
    };
  }
  if (database !== "postgres" || storage !== "object-storage") {
    return {
      level: "caution" as const,
      title: "Persistent volume configured — cloud storage gates remain",
      message: "The application reports an operator-confirmed persistent volume, but its database or media backend is still local. Verify scheduled backups and a successful restore before relying on this workspace as the sole production copy.",
      details
    };
  }
  return { level: "ready" as const, title: "Durable storage backends reported ready", message: "The health endpoint reports a managed database, private object storage and an operator-confirmed persistent volume.", details: [] as string[] };
}
