import test from "node:test";
import assert from "node:assert/strict";
import { parseByteRange } from "../http-range.mjs";

test("parses closed, open-ended and suffix byte ranges", () => {
  assert.deepEqual(parseByteRange("bytes=2-5", 10), { start: 2, end: 5 });
  assert.deepEqual(parseByteRange("bytes=7-", 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange("bytes=-4", 10), { start: 6, end: 9 });
});

test("clamps an end byte to the representation length", () => {
  assert.deepEqual(parseByteRange("bytes=8-99", 10), { start: 8, end: 9 });
});

test("marks syntactically valid but unsatisfiable ranges", () => {
  assert.deepEqual(parseByteRange("bytes=10-", 10), { unsatisfiable: true });
  assert.deepEqual(parseByteRange("bytes=8-4", 10), { unsatisfiable: true });
  assert.deepEqual(parseByteRange("bytes=-0", 10), { unsatisfiable: true });
  assert.deepEqual(parseByteRange("bytes=0-0", 0), { unsatisfiable: true });
});

test("ignores absent, malformed and unsupported multi-range headers", () => {
  assert.equal(parseByteRange(null, 10), null);
  assert.equal(parseByteRange("items=0-1", 10), null);
  assert.equal(parseByteRange("bytes=abc-def", 10), null);
  assert.equal(parseByteRange("bytes=0-1,4-5", 10), null);
});

test("rejects invalid representation sizes", () => {
  assert.throws(() => parseByteRange("bytes=0-1", -1), /non-negative safe integer/);
  assert.throws(() => parseByteRange("bytes=0-1", Number.MAX_SAFE_INTEGER + 1), /non-negative safe integer/);
});
