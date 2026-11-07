import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../../src/platform/app.ts", import.meta.url), "utf8");

test("authenticated sessions reactivate cloud-backed timeline and workflow workspaces", () => {
  const handler = app.match(/window\.addEventListener\("ev:authenticated",\(\)=>\{([^}]+)\}\)/)?.[1] || "";
  assert.match(handler, /initTimelineWorkspace\(\)/);
  assert.match(handler, /initWorkflowWorkspace\(\)/);
});

test("opening Video Editor refreshes timeline data after the view is mounted", () => {
  assert.match(app, /if\(id==="video"\)void initTimelineWorkspace\(\)/);
});

test("opening Workflow Canvas refreshes workflow data after the view is mounted", () => {
  assert.match(app, /if\(id==="canvas"\)void initWorkflowWorkspace\(\)/);
});
