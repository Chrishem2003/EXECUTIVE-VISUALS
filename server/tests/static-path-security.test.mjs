import test from "node:test";
import assert from "node:assert/strict";
import { isBlockedDotPath } from "../static-path-security.mjs";

test("blocks dotfiles at root and in nested directories", () => {
  for (const path of ["/.env", "/.git/config", "/.github/workflows/ci.yml", "/assets/.secret", "/folder/.htaccess", "/.npmrc"]) {
    assert.equal(isBlockedDotPath(path), true, path);
  }
});

test("blocks percent-encoded dotfile and dot-directory paths", () => {
  for (const path of ["/%2eenv", "/%2egit/config", "/assets/%2esecret", "/%252eenv"]) {
    assert.equal(isBlockedDotPath(path), true, path);
  }
});

test("blocks backslash path separators and encoded NUL bytes", () => {
  assert.equal(isBlockedDotPath("/assets\\.env"), true);
  assert.equal(isBlockedDotPath("/assets/%00secret"), true);
});

test("allows ordinary application routes and static assets", () => {
  for (const path of ["/", "/index.html", "/assets/app.js", "/favicon.ico", "/projects/123"]) {
    assert.equal(isBlockedDotPath(path), false, path);
  }
});

test("fails closed on malformed percent encoding", () => {
  assert.equal(isBlockedDotPath("/assets/%E0%A4%A"), true);
});
