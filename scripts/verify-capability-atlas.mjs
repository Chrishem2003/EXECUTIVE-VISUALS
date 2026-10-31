import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const catalog = JSON.parse(await readFile(resolve(root, "docs/capability-catalog.json"), "utf8"));
const typedSource = await readFile(resolve(root, "src/core/capability-atlas.ts"), "utf8");
const issues = [];

if (catalog.schemaVersion !== 1) issues.push("Unsupported catalog schemaVersion.");
const typed = [...typedSource.matchAll(/spec\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)"/g)]
  .map(match => ({ id: match[1], domain: match[2], label: match[3] }));
if (!Array.isArray(catalog.domains) || catalog.domains.length < 10) issues.push("Expected a broad domain inventory.");
if (!Array.isArray(catalog.capabilities) || catalog.capabilities.length < 30) issues.push("Capability inventory is unexpectedly small.");
if (catalog.sourceOfTruth !== "src/core/capability-atlas.ts") issues.push("Catalog must identify the typed registry as its source of truth.");
if (catalog.capabilityCount !== typed.length) issues.push("Declared capability count does not match the typed registry.");
if (catalog.domainCount !== catalog.domains.length) issues.push("Declared domain count does not match the catalog.");

const ids = new Set();
const coveredDomains = new Set();
for (const item of catalog.capabilities ?? []) {
  if (!Array.isArray(item) || item.length !== 3) {
    issues.push("Each capability must be [id, domain, label].");
    continue;
  }
  const [id, domain, label] = item;
  if (typeof id !== "string" || !id.trim()) issues.push("Capability ID must be a non-empty string.");
  if (ids.has(id)) issues.push(`Duplicate capability ID: ${id}`);
  ids.add(id);
  if (!catalog.domains.includes(domain)) issues.push(`Unknown domain ${domain} for ${id}`);
  coveredDomains.add(domain);
  if (typeof label !== "string" || !label.trim()) issues.push(`Missing label for ${id}`);
}
for (const domain of catalog.domains ?? []) {
  if (!coveredDomains.has(domain)) issues.push(`Domain has no capabilities: ${domain}`);
}
const typedIds = new Set(typed.map(item => item.id));
for (const item of typed) {
  if (!ids.has(item.id)) issues.push(`Typed capability missing from JSON catalog: ${item.id}`);
  const row = catalog.capabilities.find(entry => entry[0] === item.id);
  if (row && (row[1] !== item.domain || row[2] !== item.label)) {
    issues.push(`Catalog metadata differs from typed registry: ${item.id}`);
  }
}
for (const id of ids) if (!typedIds.has(id)) issues.push(`Catalog entry missing from typed registry: ${id}`);
if (!Array.isArray(catalog.requiredCapabilityFields) || catalog.requiredCapabilityFields.length < 10) {
  issues.push("Required capability contract fields are incomplete.");
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
  console.log(`Capability catalog valid: ${ids.size} typed capabilities across ${coveredDomains.size} domains.`);
}
