import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";

const migration=await readFile(new URL("../../supabase/migrations/20261118120000_cloud_review_asset_version_binding.sql",import.meta.url),"utf8");

test("adds a nullable checksum without fabricating historical review versions",()=>{
 assert.match(migration,/add column if not exists asset_sha256 text/i);
 assert.doesNotMatch(migration,/update executive_visuals\.reviews\s+set\s+asset_sha256/i);
});

test("constrains new review fingerprints to normalized SHA-256 hex",()=>{
 assert.match(migration,/asset_sha256 is null or asset_sha256 ~ '\^\[a-f0-9\]\{64\}\$'/i);
});

test("includes the source fingerprint in append-only review event payloads",()=>{
 assert.match(migration,/'assetSha256',\s*new\.asset_sha256/i);
 assert.match(migration,/insert into executive_visuals\.review_events/i);
});
