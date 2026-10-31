import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const catalogPath = resolve(process.cwd(), "docs/capability-catalog.json");
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const issues = [];

if (catalog.schemaVersion !== 1) issues.push("Unsupported catalog schemaVersion.");
if (!Array.isArray(catalog.domains) || catalog.domains.length < 10) issues.push("Expected a broad domain inventory.");
if (!Array.isArray(catalog.capabilities) || catalog.capabilities.length < 30) issues.push("Capability inventory is unexpectedly small.");

const ids = new Set();
const coveredDomains = new Set();
for (const item of catalog.capabilities ?? []) {
  if (!Array.isArray(item) || item.length !== 3) {
    issues.push("Each capability must be [id, domain, description].");
    continue;
  }
  const [id, domain, description] = item;
  if (typeof id !== "string" || !id.trim()) issues.push("Capability ID must be a non-empty string.");
  if (ids.has(id)) issues.push(`Duplicate capability ID: ${id}`);
  ids.add(id);
  if (!catalog.domains.includes(domain)) issues.push(`Unknown domain ${domain} for ${id}`);
  coveredDomains.add(domain);
  if (typeof description !== "string" || !description.trim()) issues.push(`Missing description for ${id}`);
}
for (const domain of catalog.domains ?? []) {
  if (!coveredDomains.has(domain)) issues.push(`Domain has no capabilities: ${domain}`);
}
for (const field of catalog.requiredCapabilityFields ?? []) {
  if (typeof field !== "string" || !field.trim()) issues.push("Invalid required capability field.");
}
if (!Array.isArray(catalog.jobStates) || !catalog.jobStates.includes("awaiting_approval") || !catalog.jobStates.includes("partial")) {
  issues.push("Job lifecycle must include approval and partial-result states.");
}
if (!Array.isArray(catalog.invariants) || catalog.invariants.length < 8) {
  issues.push("Safety and reliability invariants are incomplete.");
}

if (issues.length) {
  console.error("Capability catalog validation failed:");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log(`Capability catalog valid: ${ids.size} capabilities across ${coveredDomains.size} domains.`);
}
