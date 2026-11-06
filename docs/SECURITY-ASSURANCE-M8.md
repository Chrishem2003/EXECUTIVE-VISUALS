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
| Origin handling | Requests with a non-allowlisted Origin are rejected; same-origin matching checks exact serialized origin, host and effective scheme; configured/same-origin origins receive credentialed CORS headers | Integration test added |
| API authentication | API routes authenticate before serving protected workspace data | Existing integration tests cover anonymous denial |
| Project authorization | Existing project-access helpers distinguish owner/editor/reviewer/viewer permissions; API regression now verifies collaborator revocation across project assets, timelines, workflows, reviews and jobs, while the owner retains project-job access | Expanded integration coverage; full resource-family matrix remains open |
| Upload ownership | Resumable upload sessions are owner-scoped, size-bounded, time-limited and project-write checked | Existing upload tests |
| Response protections | JSON responses include security headers; HTML uses a restrictive Content Security Policy | Existing integration tests |

## 2. Findings and remaining verification

### M8-01 — Explicit production cookie and CORS configuration
**Priority:** P1 configuration gate  
The cookie's Secure attribute is conditional on NODE_ENV=production or COOKIE_SECURE=true. Before any production release, verify the deployed environment sets one of these deliberately and that CORS_ORIGINS contains only the exact trusted application origins. This is a deployment verification item, not evidence that the current deployment is misconfigured.

### M8-02 — Authentication rate limiting is process-local
**Priority:** P2 architecture gate  
The in-memory limiter prunes expired buckets and enforces a configurable capacity (`RATE_LIMIT_MAX_BUCKETS`, default 10,000). Counters do not aggregate across API instances and reset when a process restarts. The current Render blueprint defines one web service, SQLite on a persistent disk, and no shared Redis/Valkey service; this is a single-instance deployment shape, not a horizontally scalable rate-limit topology. Do not add a distributed limiter or provision infrastructure in isolation. First approve and implement the durable multi-instance data/storage architecture (PostgreSQL plus shared media storage), then select a shared rate-limit backend and test atomic behavior across instances. The local memory cap is not distributed protection.

### M8-03 — Supabase identity lookup transport and timeout
**Priority:** Implemented; deployment verification remains  
The Supabase `/auth/v1/user` lookup has a configurable abort deadline (`SUPABASE_AUTH_TIMEOUT_MS`, default 5 seconds, clamped to 100–30,000 ms), accepts only bounded Bearer tokens, requires HTTPS for remote identity-provider URLs (HTTP is allowed only for loopback development), and fails closed on timeout, network errors, non-success responses or malformed identity payloads. Unit tests use controlled fetch implementations. Verify timeout behavior through the deployed proxy/network path before release. Never log bearer tokens or provider response bodies.

### M8-04 — Session lifecycle controls
**Priority:** Implemented for local-password sessions; federated-provider lifecycle remains provider-managed  
Local sessions enforce a server-side sliding inactivity timeout (default 30 minutes, configurable with `SESSION_IDLE_TIMEOUT_MINUTES`, bounded to 5–1,440 minutes) and an absolute maximum lifetime (default 30 days, configurable with `SESSION_ABSOLUTE_DAYS`, bounded to 1–90 days). The browser cookie is refreshed on authenticated requests and its Max-Age is bounded by the idle and remaining absolute lifetime. Expired sessions are deleted server-side and the cookie is cleared. The `POST /api/auth/password` route requires the current password, updates the salted scrypt password hash, revokes every existing local session and issues a new session to the current device.

Local accounts are limited to 10 concurrent sessions by default (`SESSION_MAX_CONCURRENT`, bounded to 1–25). When a new login exceeds the configured limit, the least recently active session(s) are revoked first. Authenticated users can list their own active local sessions with `GET /api/auth/sessions` and revoke an individual session with `DELETE /api/auth/sessions/:id`. The Project Settings workspace exposes this inventory, identifies the current device, supports refresh, and asks for confirmation before revocation. The API returns opaque session identifiers and timestamps, never bearer tokens or token hashes; session ownership is enforced server-side. Session revocation requires the current local password to be re-entered and is covered by wrong-password and cross-account denial tests. These controls permit users to review and terminate their own sessions. Supabase-managed sessions remain governed by the identity provider and must be verified there; this API does not claim to revoke provider sessions. Timeout and concurrency defaults are documented starting policy values and must be reviewed against the deployment's risk classification before release. Relevant ASVS 5.0.0 checks include V7.1.1–V7.1.3, V7.3.1–V7.3.2, V7.4.1–V7.4.5 and V7.5.1–V7.5.2.
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
- Sliding idle timeout, server-side activity tracking and cookie refresh.
- Idle-expired session deletion and cookie clearing.
- Local password change requiring the current password, rotating the active session and revoking other sessions.
- Self-service local session inventory and individual revocation, including cross-account denial.
- Concurrent local session cap and least-recently-active session eviction.
- Strict Bearer-token parsing for Supabase identity verification.
- Supabase identity timeout, network-error, rejected-response, malformed-payload and remote cleartext-transport rejection.
- Project permission revalidation before resumable-upload finalization after a collaborator's access is revoked.
- API-level project membership revocation across assets, timelines, workflows, reviews and jobs; owner access to project jobs remains intact.
- Bounded in-memory rate-limit storage, expired-key pruning and capacity behavior.
- Exact same-origin scheme matching and rejection of malformed Origin serialization.

CI must pass on the draft pull request before these changes are considered verified.

## 4. Tenant-isolation evidence matrix

| Resource family | Verified behavior | Evidence / remaining boundary |
|---|---|---|
| Projects and memberships | Owner-managed membership; editor/reviewer/viewer permissions are distinct; former members lose project access | API integration tests |
| Assets and media | Personal assets are owner-only; project assets follow project read/write roles; revoked members lose list/detail access | API integration tests; cloud asset authorizer unit tests |
| Resumable uploads | Upload sessions are owner-scoped; project write permission is rechecked on chunk and completion paths | Upload integration tests, including revoked collaborator finalization |
| Timelines and workflows | Authorized project members can read; editors can modify; viewers cannot modify; revoked members lose access | API integration tests |
| Jobs and workflow runs | Project-scoped job access follows current membership; former member denied while owner retains access | API integration tests; workflow-run ownership tests |
| Reviews | Reviewer/editor capabilities are enforced; revoked members cannot read project reviews | API integration tests |
| Notifications | User inbox is private and project notifications are additionally filtered by current project membership; revoked reviewer loses notification/read access | API integration tests |
| Audit events | Project audit feed requires current project access; cursor pagination and outsider/former-member denial are tested | API integration tests |
| Usage telemetry | Account usage is owner-scoped; project usage is visible to authorized members and denied after membership revocation | API integration tests |
| Transformation plans | Plans and approvals are project/owner scoped; rights, consent, budget, idempotency and execution-state checks are enforced | API and module tests |
| Cloud asset authorization | Owner/editor write; reviewer/viewer read-only; unrelated identities and malformed IDs denied; lookup errors fail closed | Cloud authorization unit tests |

This matrix records the currently inspected test evidence; it is not a substitute for independent penetration testing or a complete review of every cloud timeline, storage, worker, webhook and future resource endpoint. Continue expanding it whenever new sensitive resource families are introduced.

## 4. Architecture decision and release gates

The current Render blueprint is a single web service backed by SQLite on a persistent disk. Multi-instance scaling is blocked until the application data store and media storage are migrated to shared durable services. A shared rate limiter is therefore a dependent architecture milestone, not a standalone Redis toggle. Preserve the current single-instance deployment until that migration has its own staging acceptance, backup/restore evidence and rollback plan.



Do not enable production release based solely on green CI. Before production approval, require:

1. Explicit production cookie and exact CORS origin configuration.
2. Distributed rate limiting appropriate to the deployment topology.
3. Verify the bounded external identity-provider timeout under the deployed network/proxy conditions.
4. Review configured inactivity/absolute timeout and concurrent-session policies; verify local password-change and self-service revocation, then verify Supabase session lifecycle separately with the identity provider.
5. Complete the remaining cloud storage, cloud timeline, worker, webhook and future-resource authorization review; the current local API tenant-isolation matrix is expanded but is not a complete independent verification.
6. Backup/restore and rollback evidence for persistent storage and database changes.
7. Human release approval after staging acceptance.

## 5. Scope and safety

This milestone hardens malformed session-cookie parsing, bounded Supabase identity verification, Bearer-token parsing, remote TLS requirements, process-local rate-limit memory bounds, and exact CORS origin validation; it also adds regression tests for these controls and upload-permission revalidation. It does not change authentication providers, authorization roles, provider activation, or production infrastructure. All automated integration tests use the isolated local API process and temporary SQLite data.
