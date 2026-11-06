import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryRateLimiter } from "../rate-limiter.mjs";

test("rate limiter enforces a fixed window per key", () => {
  let now = 1000;
  const limiter = createInMemoryRateLimiter({ clock: () => now });
  assert.equal(limiter.allow("client-a", 2, 1000), true);
  assert.equal(limiter.allow("client-a", 2, 1000), true);
  assert.equal(limiter.allow("client-a", 2, 1000), false);
  assert.equal(limiter.allow("client-b", 2, 1000), true);
  now += 1000;
  assert.equal(limiter.allow("client-a", 2, 1000), true);
});

test("rate limiter prunes expired identities before refusing new buckets", () => {
  let now = 0;
  const limiter = createInMemoryRateLimiter({ maxBuckets: 2, clock: () => now });
  assert.equal(limiter.allow("a", 1, 100), true);
  assert.equal(limiter.allow("b", 1, 100), true);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.allow("c", 1, 100), false);
  now = 101;
  assert.equal(limiter.allow("c", 1, 100), true);
  assert.equal(limiter.size, 1);
});

test("rate limiter rejects new identities rather than growing without bound", () => {
  let now = 10;
  const limiter = createInMemoryRateLimiter({ maxBuckets: 1, clock: () => now });
  assert.equal(limiter.allow("a", 10, 1000), true);
  assert.equal(limiter.allow("b", 10, 1000), false);
  assert.equal(limiter.size, 1);
});
