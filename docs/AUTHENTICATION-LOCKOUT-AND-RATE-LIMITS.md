# Authentication lockout and rate-limit policy

## Account password lockout

This policy is enforced by the API for both local development passwords and Supabase password sign-in. It is independent of the shorter request-rate budgets.

| Event | Result |
|---|---|
| First wrong password | 401; failure count 1 |
| Second consecutive wrong password | 401; failure count 2 |
| Third consecutive wrong password | 423; account identifier locked for 15 minutes |
| Requests while locked | 423; no password verification; remaining wait returned in `Retry-After` |
| First wrong password after the lock expires | Immediately locks for 30 minutes |
| Next wrong attempt after each expired lock | Lock duration doubles: 1h, 2h, 4h, 8h, 16h, then capped at 24h |
| Correct password | Successful sign-in; failure and escalation history cleared |

The lockout state is stored in the application SQLite database and therefore survives a process restart on the same persistent disk. Failed-login counter updates use `BEGIN IMMEDIATE` so concurrent requests serialize the read/modify/write sequence instead of overwriting one another's increments. SQLite is configured with WAL and a 5-second busy timeout. This protects concurrent requests sharing the same SQLite database file; it does not turn per-instance SQLite into a distributed lock service. The table stores a normalized identifier digest, not the plaintext password or raw email. The lockout does not disclose whether an account exists: unknown identifiers receive the same generic failures and lock response.

## Privacy-preserving authentication security events

The API stores a separate `auth_security_events` trail for failed sign-ins, newly applied lockouts, attempts blocked by an active lockout, and successful sign-ins. Each event stores only the normalized identifier digest (HMAC-SHA-256 when `AUTH_IDENTIFIER_HMAC_KEY` is configured), event type, failure/lock level, lock expiry and timestamp. It does not store raw email addresses, passwords, tokens or client IP addresses. Events are retained for at most 90 days and capped at 50,000 rows per application database; old records are pruned when new events are written. These records are currently an internal operational trail, not a user-facing dashboard or alerting integration.

## Independent request-rate budgets

- Source-IP authentication budget: default 10 requests per minute across authentication endpoints, configurable using `AUTH_RATE_LIMIT`.
- Per-email sign-in budget: 8 attempts per 15 minutes.
- Per-email signup budget: 5 attempts per hour.
- Per-email password-recovery budget: 3 attempts per hour.
- Email keys are normalized and hashed before they enter the limiter. The default `memory` backend is process-local; the optional `redis-rest` backend uses an atomic Redis Lua `INCR`/`PEXPIRE` operation so IP and email budgets are shared across API instances using the same Redis database and namespace.
- These request budgets are separate from the 3-failure account lockout. A 429 request throttle does not consume an account password failure.

## Security boundaries and rollout

1. The SQLite account lockout is durable for a single application instance using its persistent disk. It is not a shared multi-instance lock service.
2. The default per-IP and per-email request budgets use in-memory buckets. They reset on restart and are not shared across instances.
3. For a shared limiter, configure `AUTH_RATE_LIMIT_BACKEND=redis-rest`, `RATE_LIMIT_REDIS_REST_URL` (HTTPS endpoint), `RATE_LIMIT_REDIS_REST_TOKEN` (server-only bearer token), and optionally `RATE_LIMIT_REDIS_NAMESPACE` (default `executive-visuals`). The backend sends atomic Lua `INCR` + `PEXPIRE` commands, hashes bucket identifiers before sending keys, and fails closed with HTTP 503 when Redis is unavailable; it never silently falls back to local memory. Set `REQUIRE_DISTRIBUTED_AUTH_RATE_LIMIT=true` in the public production service to make startup fail unless the Redis backend is selected. Keep this release gate disabled only for isolated staging/local environments that are intentionally using one instance. The health endpoint reports the backend name and whether the release gate is active, never credentials. Use a dedicated Redis database/namespace and configure retention, access controls and network restrictions.
4. The API ignores `X-Forwarded-For` unless the socket peer exactly matches an IP in the server-only `TRUSTED_PROXY_IPS` comma-separated allowlist. For an allowlisted peer, it accepts only a fully valid IP chain and uses the rightmost forwarded address; missing or malformed headers fall back to the peer address. Configure the edge proxy to append the address it observed as the rightmost entry and prevent clients from controlling that value. The allowlist currently supports exact IP addresses, not CIDR ranges; do not enable forwarded-header trust for dynamic proxy ranges without extending and testing the matcher.
5. Add CAPTCHA/Turnstile or equivalent risk-based challenge for suspicious sign-in/signup/recovery traffic.
6. Add verified account recovery and security notifications. Recovery must not silently bypass identity verification; an administrative unlock must be allowlisted, audited and time-bounded.
7. Account lockout can be abused to deny a victim access. Keep public errors non-enumerating, monitor repeated lockouts, provide verified recovery, and review the progressive policy before public beta.
8. Set `AUTH_IDENTIFIER_HMAC_KEY` to a cryptographically random secret of at least 32 bytes for public deployment. Lockout identifiers use HMAC-SHA-256 when this key is configured; the key must remain server-only and stable across restarts/instances. Existing SHA-256 lockout rows are migrated to HMAC on the next failed-login update without resetting their failure/lockout state. If the key is absent, legacy SHA-256 behavior remains for development compatibility; production deployment must configure the key before enabling public sign-in.
9. Do not log passwords, access/refresh tokens, raw email addresses in security telemetry, or provider error bodies.

## Verification

Unit tests cover the privacy-preserving event trail, bounded retention, blocked-attempt/success events, the three-failure threshold, 15-minute initial duration, immediate 30-minute extension after an expired lock, exponential progression and 24-hour cap, successful reset, identifier hashing and legacy-to-HMAC migration. Client-IP tests cover untrusted spoofed headers, trusted proxy chains, malformed headers and invalid configuration. Redis REST limiter tests cover atomic command construction, hashed keys, normalized email budgets, denial at the threshold, invalid responses and fail-closed outage behavior. The API integration test covers the Supabase sign-in route, HTTP 423, and the `Retry-After: 900` header. CI must pass on the exact latest commit before this policy is considered verified.
