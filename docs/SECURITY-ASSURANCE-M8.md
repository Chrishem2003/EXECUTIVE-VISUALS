# M8 Security Assurance Baseline

**Status:** In progress  
**Scope:** Repository-level defensive review and automated tests on the draft M8 branch.  
**Reference baseline:** OWASP Application Security Verification Standard (ASVS) 5.0.0.  
**Release status:** Not a production-readiness approval.

## 1. Evidence-backed controls

| Area | Current evidence | Status |
|---|---|---|
| Session entropy and storage | Local sessions use 32 random bytes; only a SHA-256 token hash is stored | Source verified; integration test added |
| Cookie protections | HttpOnly, SameSite=Strict, root path, 30-day max age; Secure when NODE_ENV=production or COOKIE_SECURE=true | Source verified; integration test added |
| Logout | Logout deletes the matching persisted session hash and expires the cookie | Integration test added |
| Malformed cookie handling | Invalid percent-encoding now resolves to an empty/invalid token and fails closed | Code change and integration test added |
| Origin handling | Requests with a non-allowlisted Origin are rejected; configured/same-host origins receive credentialed CORS headers | Integration test added |
| API authentication | API routes authenticate before serving protected workspace data | Existing integration tests cover anonymous denial |
| Project authorization | Existing project-access helpers and cloud asset authorization distinguish owner/editor/reviewer/viewer permissions | Existing unit/integration coverage |
| Upload ownership | Resumable upload sessions are owner-scoped, size-bounded, time-limited and project-write checked | Existing upload tests |
| Response protections | JSON responses include security headers; HTML uses a restrictive Content Security Policy | Existing integration tests |

## 2. Findings and remaining verification

### M8-01 — Explicit production cookie and CORS configuration
**Priority:** P1 configuration gate  
The cookie's Secure attribute is conditional on NODE_ENV=production or COOKIE_SECURE=true. Before any production release, verify the deployed environment sets one of these deliberately and that CORS_ORIGINS contains only the exact trusted application origins. This is a deployment verification item, not evidence that the current deployment is misconfigured.

### M8-02 — Authentication rate limiting is process-local
**Priority:** P2  
The current rate limiter stores counters in an in-memory map keyed by remote address and route category. Limits therefore do not aggregate across multiple API instances and reset when a process restarts. Before horizontally scaling or exposing local-password authentication broadly, use a shared rate-limit store and add distributed-limit tests.

### M8-03 — Supabase identity lookup has no explicit request timeout
**Priority:** P2 reliability/security hardening  
The Supabase /auth/v1/user lookup uses fetch without an explicit abort deadline. Add a bounded timeout and fail closed on timeout/network errors, with tests using a controlled fetch implementation. Do not log bearer tokens or provider response bodies.

### M8-04 — Session lifecycle coverage is incomplete
**Priority:** P2  
Expired-session rejection and pruning are now covered by an integration test. Session invalidation after credential changes and the intended idle/absolute lifetime policy still need review. The current implementation has a 30-day absolute expiry; production policy approval remains outstanding.

### M8-05 — Production evidence is not yet available
**Priority:** Release blocker  
No production environment, deployment configuration, secrets, live user data, or provider credentials were inspected as part of this code review. No active penetration test or independent security assessment is claimed.

## 3. Verification added in M8

The M8 integration test exercises:

- HttpOnly and SameSite=Strict session cookie attributes.
- SHA-256 hash persistence rather than plaintext session-token storage.
- Malformed percent-encoded cookie fail-closed behavior.
- Cross-origin request rejection.
- Same-origin credentialed API access.
- Logout cookie expiry and server-side session revocation.
- Expired-session rejection and removal from persisted sessions.

CI must pass on the draft pull request before this change is considered verified.

## 4. Release gates

Do not enable production release based solely on green CI. Before production approval, require:

1. Explicit production cookie and exact CORS origin configuration.
2. Distributed rate limiting appropriate to the deployment topology.
3. Bounded external identity-provider request timeouts.
4. Expired-session and credential-change lifecycle tests.
5. Tenant-isolation tests for every sensitive object family, including projects, assets, uploads, jobs, timelines, comments and usage records.
6. Backup/restore and rollback evidence for persistent storage and database changes.
7. Human release approval after staging acceptance.

## 5. Scope and safety

This milestone changes only malformed session-cookie parsing and adds integration tests. It does not change authentication providers, session lifetime, CORS policy, authorization roles, database schema, provider activation, or production infrastructure. All automated integration tests use the isolated local API process and temporary SQLite data.
