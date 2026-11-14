import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const shard = Number(process.argv[2]);
const shardCount = Number(process.argv[3]);
if (!Number.isInteger(shard) || !Number.isInteger(shardCount) || shardCount < 1 || shard < 1 || shard > shardCount) {
  console.error("Usage: node scripts/run-server-test-shard.mjs <shard> <shard-count>");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../server/tests");
const files = readdirSync(root)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .filter((_, index) => index % shardCount === shard - 1)
  .map((name) => resolve(root, name));

if (files.length === 0) {
  console.error(`No server test files assigned to shard ${shard}/${shardCount}`);
  process.exit(2);
}

console.log(`Running ${files.length} server test files in shard ${shard}/${shardCount}`);
const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...files], {
  stdio: "inherit",
});
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
