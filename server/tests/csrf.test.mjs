import test from "node:test";
import assert from "node:assert/strict";
import { createCsrfToken, isValidCsrfRequest, requiresCsrf } from "../csrf.mjs";

test("CSRF tokens are high-entropy URL-safe values", () => {
  const token = createCsrfToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, createCsrfToken());
});

test("safe methods do not require a CSRF token", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(requiresCsrf(method), false);
    assert.equal(isValidCsrfRequest({ method }), true);
  }
});

test("unsafe methods require matching cookie and request header", () => {
  const token = createCsrfToken();
  assert.equal(requiresCsrf("POST"), true);
  assert.equal(isValidCsrfRequest({ method: "POST", cookieHeader: "ev_csrf=" + token, headerToken: token }), true);
  assert.equal(isValidCsrfRequest({ method: "POST", cookieHeader: "ev_csrf=" + token, headerToken: createCsrfToken() }), false);
  assert.equal(isValidCsrfRequest({ method: "POST", cookieHeader: "ev_csrf=" + token, headerToken: "" }), false);
  assert.equal(isValidCsrfRequest({ method: "DELETE", cookieHeader: "", headerToken: token }), false);
});

test("malformed and truncated CSRF cookie input cannot validate", () => {
  const token = createCsrfToken();
  assert.equal(isValidCsrfRequest({ method: "PATCH", cookieHeader: "ev_csrf=%" + token, headerToken: token }), false);
  assert.equal(isValidCsrfRequest({ method: "PATCH", cookieHeader: "ev_csrf=short", headerToken: "short" }), false);
  assert.equal(isValidCsrfRequest({ method: "PATCH", cookieHeader: "other=" + token, headerToken: token }), false);
});
