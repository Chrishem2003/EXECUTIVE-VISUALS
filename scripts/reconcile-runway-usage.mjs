import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  queryRunwayOrganizationUsage,
  loadRunwayBillingEstimates,
  reconcileRunwayDailyUsage
} from "../server/runway-usage-reconciliation.mjs";

function parseDateArgument(name) {
  const prefix = "--" + name + "=";
  const argument = process.argv.find(value => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

function defaultWindow() {
  const before = new Date();
  before.setUTCHours(0, 0, 0, 0);
  const beforeDate = before.toISOString().slice(0, 10);
  before.setUTCDate(before.getUTCDate() - 7);
  return { startDate: before.toISOString().slice(0, 10), beforeDate };
}

async function main() {
  const defaults = defaultWindow();
  const startDate = parseDateArgument("from") || defaults.startDate;
  const beforeDate = parseDateArgument("before") || defaults.beforeDate;
  const dataDir = resolve(process.env.DATA_DIR || "./data");
  const dbFile = resolve(process.env.DB_FILE || join(dataDir, "executive-visuals.sqlite"));
  if (!existsSync(dbFile)) throw new Error("Billing database does not exist at the configured DB_FILE.");
  if (!String(process.env.RUNWAY_API_KEY || process.env.RUNWAYML_API_SECRET || "").trim()) {
    throw new Error("Set RUNWAY_API_KEY on the server before querying Runway usage.");
  }

  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const [provider, billingEstimates] = await Promise.all([
      queryRunwayOrganizationUsage({ startDate, beforeDate }),
      Promise.resolve(loadRunwayBillingEstimates(db, { startDate, beforeDate }))
    ]);
    const reconciliation = reconcileRunwayDailyUsage({
      actualUsage: provider.totals,
      billingEstimates
    });
    process.stdout.write(JSON.stringify({
      window: provider.window,
      evidenceType: provider.evidenceType,
      settlementEligible: false,
      reconciliation
    }, null, 2) + "\n");
  } finally {
    db.close();
  }
}

main().catch(error => {
  process.stderr.write("Runway usage reconciliation failed: " + String(error?.message || error) + "\n");
  process.exitCode = 1;
});
