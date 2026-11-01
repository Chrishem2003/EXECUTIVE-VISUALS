#!/usr/bin/env node
/**
 * Operator-only account creation for private deployments.
 *
 * Open registration is disabled when NODE_ENV=production, so a deployment with
 * AUTH_MODE=local has no way to make its first account. Run this on the server
 * (for example from the host's shell) instead of enabling public sign-up:
 *
 *   EV_PASSWORD='a long passphrase' node scripts/create-user.mjs you@example.com
 *   node scripts/create-user.mjs you@example.com --reset   (change a password)
 *
 * The password comes from EV_PASSWORD or, when that is unset, one line on stdin.
 * It is never taken from the command line, so it stays out of shell history.
 * Hashing matches the login route: scrypt(password, salt, 64), hex encoded.
 */
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { openDatabase } from "../server/db.mjs";

const args = process.argv.slice(2);
const reset = args.includes("--reset");
const email = String(args.find(arg => !arg.startsWith("--")) || "").trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error("Usage: node scripts/create-user.mjs <email> [--reset]   (password via EV_PASSWORD or stdin)");
  process.exit(2);
}

async function readPassword() {
  if (process.env.EV_PASSWORD) return process.env.EV_PASSWORD;
  if (process.stdin.isTTY) console.error("Password (visible as you type; at least 12 characters):");
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) { rl.close(); return line; }
  return "";
}

const password = await readPassword();
if (password.length < 12 || password.length > 256) {
  console.error("The password must be 12 to 256 characters.");
  process.exit(2);
}

const dataDir = resolve(process.env.DATA_DIR || "./data");
const dbFile = resolve(process.env.DB_FILE || join(dataDir, "executive-visuals.sqlite"));
mkdirSync(dirname(dbFile), { recursive: true });
const db = openDatabase(dbFile);

const salt = randomBytes(16).toString("hex");
const hash = scryptSync(password, salt, 64).toString("hex");
const existing = db.prepare("SELECT id FROM users WHERE email=? COLLATE NOCASE").get(email);

if (existing && !reset) {
  console.error("An account with that email already exists. Use --reset to change its password.");
  process.exit(1);
}
if (existing) {
  db.prepare("UPDATE users SET password_hash=?, password_salt=? WHERE id=?").run(hash, salt, existing.id);
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(existing.id); // a reset signs every device out
  console.log(`Password updated for ${email}. Existing sessions were ended.`);
} else {
  db.prepare("INSERT INTO users(id,email,password_hash,password_salt) VALUES(?,?,?,?)").run(randomUUID(), email, hash, salt);
  console.log(`Account created for ${email}.`);
}
db.close?.();
