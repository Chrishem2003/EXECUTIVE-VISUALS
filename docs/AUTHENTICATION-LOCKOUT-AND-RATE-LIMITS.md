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

## Independent request-rate budgets

- Source-IP authentication budget: default 10 requests per minute across authentication endpoints, configurable using `AUTH_RATE_LIMIT`.
- Per-email sign-in budget: 8 attempts per 15 minutes.
- Per-email signup budget: 5 attempts per hour.
- Per-email password-recovery budget: 3 attempts per hour.
- Email keys are normalized and hashed before they enter the in-memory limiter; the limiter's process-local storage and restart behavior remain unchanged.
- These request budgets are separate from the 3-failure account lockout. A 429 request throttle does not consume an account password failure.

## Security boundaries and rollout

1. The SQLite account lockout is durable for a single application instance using its persistent disk. It is not a shared multi-instance lock service.
2. The per-IP and per-email request budgets are in-memory. They reset on restart and are not shared across instances.
3. Before horizontal scaling or public launch, put a distributed limiter (Redis or trusted edge/WAF) in front of the API. Trust forwarded client-IP headers only when supplied by a configured trusted proxy; otherwise use the socket peer address.
4. Add CAPTCHA/Turnstile or equivalent risk-based challenge for suspicious sign-in/signup/recovery traffic.
5. Add verified account recovery and security notifications. Recovery must not silently bypass identity verification; an administrative unlock must be allowlisted, audited and time-bounded.
6. Account lockout can be abused to deny a victim access. Keep public errors non-enumerating, monitor repeated lockouts, provide verified recovery, and review the progressive policy before public beta.
7. Set `AUTH_IDENTIFIER_HMAC_KEY` to a cryptographically random secret of at least 32 bytes for public deployment. Lockout identifiers use HMAC-SHA-256 when this key is configured; the key must remain server-only and stable across restarts/instances. Existing SHA-256 lockout rows are migrated to HMAC on the next failed-login update without resetting their failure/lockout state. If the key is absent, legacy SHA-256 behavior remains for development compatibility; production deployment must configure the key before enabling public sign-in.
8. Do not log passwords, access/refresh tokens, raw email addresses in security telemetry, or provider error bodies.

## Verification

Unit tests cover the three-failure threshold, 15-minute initial duration, immediate 30-minute extension after an expired lock, exponential progression and 24-hour cap, successful reset, and identifier hashing. The API integration test covers the Supabase sign-in route, HTTP 423, and the `Retry-After: 900` header. CI must pass on the exact latest commit before this policy is considered verified.
