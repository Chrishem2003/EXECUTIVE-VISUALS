import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../../src/platform/app.ts", import.meta.url), "utf8");
const css = await readFile(new URL("../../src/platform/style.css", import.meta.url), "utf8");

test("Batch 47 exposes a generated executive brief from loaded finance sources", () => {
  assert.match(app, /EXECUTIVE INTELLIGENCE · BATCH 47/);
  assert.match(app, /data-finance-executive-generate/);
  assert.match(app, /financeState\.executiveBrief=/);
  assert.match(app, /currencyEvidence/);
  assert.match(app, /source domains were available/);
});

test("Executive brief flags unavailable evidence rather than converting gaps to zero", () => {
  assert.match(app, /Unavailable/);
  assert.match(app, /missing sources are shown as gaps, never as zero/);
  assert.match(app, /do not interpret the absence of alerts as evidence of healthy margins/);
  assert.match(app, /not a representation that no financial risks exist/);
});

test("Executive brief supports portable evidence export and print-to-PDF", () => {
  assert.match(app, /data-finance-executive-export/);
  assert.match(app, /application\/json/);
  assert.match(app, /data-finance-executive-print/);
  assert.match(app, /window\.print\(\)/);
  assert.match(css, /@media print/);
  assert.match(css, /print-executive-brief/);
});

test("Executive report styling is responsive and preserves draft/sign-off limitations", () => {
  assert.match(css, /\.executive-intelligence/);
  assert.match(css, /\.executive-kpis/);
  assert.match(css, /@media\(max-width:800px\)/);
  assert.match(app, /DRAFT · REVIEW REQUIRED/);
  assert.match(app, /not an audited financial statement/);
  assert.match(app, /verify underlying source documents/);
});
