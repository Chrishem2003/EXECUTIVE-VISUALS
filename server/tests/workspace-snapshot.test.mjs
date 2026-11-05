import test from "node:test";
import assert from "node:assert/strict";
import {
  pickWorkspace, sanitizeWorkspace, isEmptyWorkspace, workspaceFingerprint, describeWorkspace,
  LIST_KEYS, TEXT_KEYS, MAX_LIST_ITEMS, MAX_TEXT_CHARS, MAX_TEXT_ITEMS, MAX_ITEM_TEXT_CHARS
} from "../../src/core/workspace-snapshot.ts";

const appState = () => ({
  projects: [{ id: "p1", name: "Film" }], tasks: [], shots: [{ id: "s1", scene: "Opening", duration: 4 }, "junk", null],
  characters: [{ id: "c1" }], seriesPlans: [], variants: ["a", 5, "b"], graph: ["Creative brief", "Export"],
  prompt: "hello", plan: "", script: "INT. LAB", activeProject: "p1", activeSeriesId: "",
  // things that must never be saved:
  assets: [{ id: "a1", url: "blob:secret" }], cloudAssets: [{ id: "x" }], tab: "cinema", transformationDrafts: [1], apiProjectId: "u", cloudMessage: "hi", password: "hunter2"
});

test("only the allow-listed parts of the workspace are picked", () => {
  const picked = pickWorkspace(appState());
  assert.deepEqual(Object.keys(picked).sort(), [...LIST_KEYS, "variants", "graph", ...TEXT_KEYS].sort());
  for (const secret of ["assets", "cloudAssets", "tab", "transformationDrafts", "apiProjectId", "cloudMessage", "password"]) assert.ok(!(secret in picked), secret + " must not be saved");
  assert.deepEqual(picked.shots, [{ id: "s1", scene: "Opening", duration: 4 }], "non-object items are dropped");
  assert.deepEqual(picked.variants, ["a", "b"]);
});

test("picking copies the data so later edits do not change the saved copy", () => {
  const state = appState();
  const picked = pickWorkspace(state);
  state.shots[0].scene = "Changed";
  assert.equal(picked.shots[0].scene, "Opening");
});

test("a pick survives a round trip through JSON unchanged", () => {
  const picked = pickWorkspace(appState());
  const back = sanitizeWorkspace(JSON.parse(JSON.stringify(picked)));
  assert.equal(back.ok, true);
  assert.deepEqual(back.notes, []);
  assert.equal(workspaceFingerprint(back.data), workspaceFingerprint(picked));
});

test("hostile or broken snapshots are cleaned, never trusted", () => {
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"shots":[{"scene":"ok"},[1],"x",null,7],"projects":"nope","prompt":42,"plan":"fine","extra":{"a":1},"variants":[1,"v"]}');
  const result = sanitizeWorkspace(hostile);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.shots, [{ scene: "ok" }]);
  assert.ok(!("projects" in result.data) && !("prompt" in result.data) && !("extra" in result.data));
  assert.equal(result.data.plan, "fine");
  assert.deepEqual(result.data.variants, ["v"]);
  assert.equal({}.polluted, undefined, "prototype untouched");
  assert.equal(Object.prototype.hasOwnProperty.call(result.data, "__proto__"), false);
  assert.ok(result.notes.length >= 3, "problems are explained");
  for (const bad of [null, undefined, "text", 5, [], [1, 2]]) assert.equal(sanitizeWorkspace(bad).ok, false);
});

test("size limits keep a restored workspace usable", () => {
  const big = {
    shots: Array.from({ length: MAX_LIST_ITEMS + 50 }, (_, i) => ({ id: "s" + i })),
    variants: Array.from({ length: MAX_TEXT_ITEMS + 20 }, () => "v".repeat(MAX_ITEM_TEXT_CHARS + 500)),
    script: "x".repeat(MAX_TEXT_CHARS + 1000)
  };
  const { data, notes } = sanitizeWorkspace(big);
  assert.equal(data.shots.length, MAX_LIST_ITEMS);
  assert.equal(data.variants.length, MAX_TEXT_ITEMS);
  assert.ok(data.variants.every(v => v.length === MAX_ITEM_TEXT_CHARS));
  assert.equal(data.script.length, MAX_TEXT_CHARS);
  assert.ok(notes.some(n => /first 500/.test(n)));
});

test("empty means nothing to lose; default workflow steps do not count as work", () => {
  assert.equal(isEmptyWorkspace(null), true);
  assert.equal(isEmptyWorkspace({}), true);
  assert.equal(isEmptyWorkspace({ graph: ["Creative brief", "Export"], shots: [], prompt: "   " }), true);
  assert.equal(isEmptyWorkspace({ shots: [{ id: "1" }] }), false);
  assert.equal(isEmptyWorkspace({ prompt: "a cat" }), false);
  assert.equal(isEmptyWorkspace({ variants: ["x"] }), false);
});

test("the fingerprint is stable and changes only when content changes", () => {
  const a = pickWorkspace(appState());
  const reordered = { ...a }; // same content
  assert.equal(workspaceFingerprint(a), workspaceFingerprint(reordered));
  const keysShuffled = Object.fromEntries(Object.entries(a).reverse());
  assert.equal(workspaceFingerprint(keysShuffled), workspaceFingerprint(a), "key order does not matter");
  const changed = pickWorkspace({ ...appState(), prompt: "hello!" });
  assert.notEqual(workspaceFingerprint(changed), workspaceFingerprint(a));
});

test("the summary reads naturally", () => {
  assert.equal(describeWorkspace(null), "nothing yet");
  assert.equal(describeWorkspace({}), "nothing yet");
  assert.equal(describeWorkspace({ shots: [{}], projects: [{}, {}] }), "1 shot, 2 projects");
  assert.equal(describeWorkspace({ prompt: "x" }), "notes and prompts");
});
