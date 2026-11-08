# Developer and operations guide

This guide describes the current repository workflow and the safety boundaries for development and staging. It deliberately separates verified behavior from planned integrations.

## 1. Repository workflow

1. Start from the latest `main` and create a focused feature branch.
2. Inspect the existing API, database, authorization helpers, UI flow and tests before changing a subsystem.
3. Reuse the existing project, asset, job, audit and timeline primitives. Avoid parallel queues, ledgers or permission systems.
4. Add focused tests with the implementation. Prefer tests that exercise the public API and a complete user journey, not only isolated helpers.
5. Run focused verification, then `npm run typecheck`, `npm run verify:server` and `npm run build` as applicable.
6. Open a pull request with scope, security implications, test evidence, migrations, operational requirements and rollback notes.
7. Keep the PR in draft until the user journey and release gates are demonstrably complete.

Do not force-push, rewrite shared history, merge a draft, or deploy to production as a substitute for validation.

## 2. Local development

Requirements:

- Node.js 24.22.1+ (recommended); CAI supports patched Node 22.23.4+, 24.22.1+ and 26.12.1+ releases.
- npm.
- FFmpeg and FFprobe for local media execution.
- The signed C2PA integration test uses the upstream CAI test signer fixture; OpenSSL CLI is not required.

Commands:

```bash
npm ci
npm run dev
npm run typecheck
npm run verify:provenance
npm run verify:c2pa
npm run verify:server
npm run build
```

The development launcher starts the Vite UI and local API. The API defaults to port 4179. Health check: `http://127.0.0.1:4179/api/health`.

Local SQLite and media content are stored beneath `data/` by default. This folder is ignored by Git; preserve it with a backup if it contains work you need.

## 3. Environment configuration

Common local defaults are defined in `server/index.mjs`. Use environment variables for deployment-specific settings. Never commit real credentials.

| Variable | Default / behavior | Operational note |
|---|---|---|
| `PORT` / `API_PORT` | 4179 | API listener. |
| `API_HOST` | 127.0.0.1 outside production | Do not expose development mode to a public interface. |
| `DATA_DIR` | ./data | Persistent application data root. |
| `MEDIA_ROOT` | DATA_DIR/media | Keep media on durable storage in hosted environments. |
| `DB_FILE` | DATA_DIR/executive-visuals.sqlite | SQLite database location. |
| `REQUIRE_PERSISTENT_DATA_DIR` | false | Set true for services that must refuse ephemeral storage. |
| `AUTH_MODE` | local | Local auth is development-only in production. |
| `SUPABASE_URL` | unset | Dedicated approved project only. |
| `SUPABASE_PUBLISHABLE_KEY` | unset | Public client key; not a service-role secret. |
| `COOKIE_SECURE` | inferred from production mode | Use secure cookies over HTTPS. |
| `MAX_UPLOAD_BYTES` | 250 MiB | Keep bounded; verify file signatures and MIME type. |
| `CLOUD_TIMELINE_API_ENABLED` | false | Keep off until cloud release gates are complete. |
| `C2PA_TRUST_ANCHORS` | unset | Optional administrator-managed PEM trust-anchor file; without it, the adapter cannot return `valid_trusted`. |
| `C2PA_MAX_VERIFY_BYTES` | 250 MiB | Maximum file size passed to the CAI native parser. |
| `C2PA_TRUST_ANCHORS` | unset | PEM root anchors loaded server-side and supplied as CAI user anchors. |

The current code also has provider-specific settings. Inspect the adapter and readiness check before configuring any provider. A variable existing in code does not imply that its external service has been provisioned or approved.

## 4. Asset storage and provenance

### Current behavior

Uploads are written to the configured local media store and receive a SHA-256 digest. The application stores a deterministic provenance record bound to the asset ID, digest, media type, byte size, source kind and ingest timestamp. The authenticated route:

```http
GET /api/assets/:assetId/provenance
```

uses the asset's normal access check. It returns the application record and integrity verification plus a separate CAI SDK verification result. The SDK adapter is server-only and uses the stored file path, known MIME type and a file-size check. Remote manifest fetching is disabled.

This application record is useful for detecting accidental or unauthorized content/metadata mismatches when the trusted record is protected. It is not a signed C2PA manifest, a real-world identity assertion, rights clearance or proof that the depicted content is true.

### Implemented CAI Node SDK verification

The official package `@contentauth/c2pa-node` is pinned to `0.10.0` in this feature branch. The adapter uses `Reader.fromAsset`, `Context` and `reader.json()`; signing APIs are not yet connected. Review the versioned official docs before upgrading:

- [CAI Node API documentation](https://contentauth.github.io/c2pa-js/modules/_contentauth_c2pa-node.html)
- [CAI open-source documentation](https://opensource.contentauthenticity.org/docs/)
- [C2PA specification](https://spec.c2pa.org/specifications/)

Implementation requirements:

1. Add and lock an exact reviewed SDK version; do not rely on an unbounded latest version.
2. Enforce upload size, media-type allowlist, actual file signature, timeouts and parser isolation before invoking the native SDK.
3. Use a file-backed SDK asset for large or untrusted files. The SDK documentation warns that a buffer is already allocated before its 10 GB limit can reject it.
4. Pass the known MIME type. Do not rely on byte sniffing as the primary format-selection mechanism.
5. Preserve the full validation status and findings returned by the SDK. Do not infer trust from manifest presence.
6. Represent manifest presence, cryptographic validity, certificate-chain validity, timestamp validity and configured trust-policy outcome as separate facts.
7. Treat a cryptographically valid but untrusted signer differently from an invalid signature and from an asset with no manifest.
8. Keep the SDK trust anchors and policy server-side. Do not accept a browser-provided `trusted=true` field.
9. Add genuine signed fixtures from a controlled test certificate and tampering fixtures. A fabricated JSON manifest is not a cryptographic test.
10. Keep rights, consent, factual accuracy, editorial approval and identity proof separate from C2PA verification.

### Transformation continuity

When media bytes change, the output needs a new manifest describing the transformation and linking the source as an ingredient. A prior signature must not be copied as if it still authenticated the modified output.

Test lineage through ingest, proxy generation, transcode, timeline render, export and publish. If a transformation cannot preserve or recreate a valid manifest, record the provenance gap explicitly rather than silently claiming continuity.

### Signing key protection

Do not place production private keys in Git, browser code, ordinary app configuration, logs, build artifacts or developer laptops. Production signing should use a narrowly scoped authenticated signing service or KMS/HSM-backed callback signer. Establish certificate issuance, key rotation, audit, timestamping, revocation, backup and incident-response policies before enabling signing.

## 5. Authentication and authorization

- Production must not use local-password authentication.
- Every asset route must first establish the caller's access to the asset/project.
- Project membership and role checks must be enforced on the server, not only hidden in the UI.
- Private asset paths, provider URLs, service-role credentials and signing material must not be exposed to the browser.
- New endpoints must include cross-user and cross-project denial tests.
- Keep cookies HttpOnly and Secure in HTTPS production; retain the restrictive same-site policy unless a reviewed auth flow requires otherwise.

## 6. Jobs and media processing

The local queue supports durable job records, leases, recovery, bounded retries, backoff and event history. That does not by itself prove that every workflow node is connected to a production-grade cloud execution path.

Before connecting a new worker/provider:
- validate exact node/provider/model/operation contracts;
- authorize project and private inputs;
- bind quotes and approvals to the canonical request hash;
- reserve budget before paid provider submission;
- make enqueue, submission, ingestion and settlement idempotent;
- reconcile ambiguous provider outcomes rather than blindly retrying;
- return private durable asset IDs to downstream nodes;
- test worker restart, lease expiry, cancellation and partial failure.

Do not enable paid execution by default.

## 7. Staging and release

The repository includes a Render Blueprint. Review `render.yaml`, the Dockerfile, environment requirements, persistent disk configuration and estimated costs before creating or resuming a service.

Staging checklist:

- Use an isolated database and private storage dedicated to this product.
- Do not reuse NEMA or another shared Supabase project.
- Verify persistent disk mounting and restart recovery.
- Configure Supabase authentication and secure cookies.
- Confirm the API and worker use the intended shared durable state.
- Verify tenant isolation and role boundaries.
- Keep cloud timeline and paid provider flags off until their acceptance tests pass.
- Exercise upload, processing, review, export, recovery and cleanup end to end.
- Capture test output, deployment commit, migration status and rollback procedure.

Production release requires a separate approval. Merging to `main` may trigger deployment. Do not merge or deploy a draft PR, and do not apply migrations or change production resources without explicit release authorization.

## 8. Troubleshooting

### API health endpoint fails

- Confirm the API process started and is listening on port 4179.
- Check logs for missing persistent volume, invalid auth configuration or database initialization failures.
- Confirm `DATA_DIR`, `DB_FILE` and `MEDIA_ROOT` resolve to the intended writable paths.

### Upload or asset access returns 404

- Confirm the asset belongs to the signed-in user or an accessible project.
- Confirm project membership and role.
- Do not bypass the asset authorization helper to make a test pass.

### Media job reports engine unavailable

- Install FFmpeg and FFprobe and confirm both are on PATH.
- Check the exact job type's adapter; unsupported work should fail closed rather than return fake success.

### Provenance says integrity verified

- This currently means application record consistency only.
- It does not mean a C2PA manifest was found, a signature is valid, or a signer is trusted. Check the separate `c2pa` object in the same response. `not_available` means no manifest; `not_supported` means the file format or extension is outside the adapter allowlist; `invalid`, `valid_untrusted`, `valid_trusted` and `verification_error` are separate SDK outcomes.

### Hosted service loses work after restart

- Confirm a persistent volume is mounted and `REQUIRE_PERSISTENT_DATA_DIR=true`.
- Confirm database and media paths are inside the mounted volume.
- Do not use ephemeral hosting for user data.

## 9. Documentation maintenance

When a capability changes, update all applicable records in the same PR:

- README: user/developer-facing current behavior and setup.
- Implementation status: what is implemented, partial, blocked or planned.
- Feature-specific design/operations document: contract, security boundaries and acceptance tests.
- Master build plan: priority and dependency changes.

Never promote a planned feature to implemented status based only on a design, UI control, mocked test or merged but unverified code.
