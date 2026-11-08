# Asset provenance and Content Credentials

**Status:** application-level SHA-256 provenance and a server-side CAI Node SDK verification adapter are implemented on the feature branch. The SDK is pinned to 0.10.0 and connected to the authenticated asset provenance route. Production signing and transformation-manifest creation are not yet implemented.

## Current implementation

On every accepted upload, the API:

1. Streams the file to storage while calculating SHA-256.
2. Validates the media signature and rejects empty/unsupported content.
3. Creates a deterministic `executive-visuals.provenance.v1` record bound to the asset ID, actual SHA-256, media type, byte size, source kind and UTC ingest timestamp.
4. Stores the record in existing asset metadata and includes the record hash in the upload audit event.
5. Exposes authenticated verification at `GET /api/assets/:assetId/provenance`, protected by the same project/asset access boundary as the asset itself.

The verifier checks the record hash and compares its asset identity, media type, size and content hash with the current asset row. Old assets without a record return `not_available`; they are not silently treated as verified.

## Current verification states

- `integrity_verified`: the application record is internally consistent and matches the asset row.
- `invalid`: the record is malformed, altered or no longer matches the asset row.
- `not_available`: no supported application provenance record exists.

The application record is **not** a C2PA Content Credential, digital signature, real-world identity proof, legal rights clearance or factual verification. The API now returns a separate `c2pa` verification result from the CAI SDK. The two checks must never be conflated. SHA-256 protects consistency only when the trusted record itself is protected; a privileged attacker who can rewrite both the asset row and record could replace them together.

## Official CAI Node SDK integration

Use the maintained official `@contentauth/c2pa-node` package from the CAI `c2pa-js` monorepo. The SDK is server-side native Node code, not a browser dependency. This feature branch pins package version `0.10.0` and wires the adapter into the asset route.

- [Official Node API documentation](https://contentauth.github.io/c2pa-js/modules/_contentauth_c2pa-node.html)
- [Official CAI documentation](https://opensource.contentauthenticity.org/docs/)
- [Published package](https://www.npmjs.com/package/@contentauth/c2pa-node)
- [C2PA specification](https://spec.c2pa.org/specifications/)

At the time this guide was revised, the published package was `0.10.0`. Review the exact release and its changelog before pinning it. The documented runtime requirement is Node.js 22 or later; use a current patched release. Normal installation downloads precompiled native binaries; Rust is needed for source builds, not the normal package install.

### Implemented verification adapter

The current adapter lives in `server/c2pa-verification.mjs` and is invoked by `GET /api/assets/:assetId/provenance` after the existing asset access check. The first allowlist covers JPEG, PNG, WebP, GIF, MP4, MOV, MP3, M4A, WAV and PDF where the corresponding file extension matches. Other file types are explicitly returned as `not_supported` without calling the native parser. It:

- Uses `Reader.fromAsset({ path, mimeType }, new Context(...))` against the server-owned media file; it does not accept browser-supplied paths or verification results.
- Disables remote manifest fetching to prevent parser-triggered outbound URL requests.
- Enforces a configured maximum file size (default 250 MiB) and checks that the on-disk size still matches the asset row before parsing.
- Preserves up to 50 SDK validation findings with bounded code, explanation and URL fields.
- Maps SDK `validation_state` values `Invalid`, `Valid` and `Trusted` to application states. A `Trusted` result is only exposed as `valid_trusted` when `C2PA_TRUST_ANCHORS` points to an administrator-controlled PEM trust-anchor file; otherwise it is downgraded to `valid_untrusted`.
- Fails closed on missing SDK, missing file, size mismatch, unknown validation state, invalid trust-anchor path and SDK errors.

Current environment settings:

| Variable | Purpose | Default |
|---|---|---|
| `C2PA_TRUST_ANCHORS` | Local PEM root trust-anchor file; its PEM content is loaded server-side and passed as CAI user anchors | Unset |
| `C2PA_MAX_VERIFY_BYTES` | Maximum asset size passed to the native parser | 262144000 bytes (250 MiB) |

The adapter is verification-only. It does not sign assets or claim transformation continuity.

### Verification adapter contract

Implement a server-only adapter with an injectable SDK boundary so unit tests can run without loading the native binary. Production integration should:

1. Load the SDK lazily from the server runtime.
2. Construct a `Context` with explicit verification and trust settings.
3. Use `Reader.fromAsset` with the trusted storage path and known MIME type.
4. Read the manifest store using `reader.json()`, the active manifest using `reader.getActive()`, and embedded status using `reader.isEmbedded()`.
5. Preserve the SDK's original validation status/findings in a bounded, sanitized response.
6. Return a structured outcome that separates manifest presence, cryptographic validation, certificate-chain and timestamp validation, trust-policy outcome, and SDK/parser errors or unsupported formats.
7. Keep the raw manifest store available only to authorized callers and redact unnecessary sensitive metadata from logs.
8. Fail closed on SDK load errors, parser errors, unknown status values or unavailable trust policy. Never convert an error into `valid` or `trusted`.

Do not infer the SDK's trust result from a manifest being present or from an empty error list. Preserve the SDK's actual validation result and map it only after contract tests against the pinned release.

### Resource safety

- Enforce the application's upload size limit before parsing.
- Use a file-backed asset for large/untrusted media. The SDK documents a 10 GB upper bound and notes that a buffer is already allocated before the bound can reject it.
- Always provide a known `mimeType`; byte-based fallback detection is slower and less reliable.
- Run parsing in a constrained worker/process with CPU, memory and wall-clock limits where practical.
- Do not allow untrusted remote manifest URLs to trigger unrestricted server-side fetches. Configure remote manifest fetching deliberately.
- Keep SDK/native library upgrades pinned and reviewed.

### Required application status vocabulary

The application API should distinguish at least:

- `not_available`: no C2PA manifest found.
- `not_supported`: the media type is not in the current adapter allowlist or the file extension does not match its declared MIME type.
- `invalid`: cryptographic or structural validation failed.
- `valid_untrusted`: cryptographic validation succeeded, but the configured signer/trust policy does not establish trust.
- `valid_trusted`: cryptographic validation and the explicitly configured trust policy both succeeded.
- `verification_error`: the SDK or trust service could not complete verification; this is not a valid result.

These are application-level labels. Preserve the exact SDK validation codes and messages alongside the mapped state. Trust policy must be explicit, versioned and testable.

## Signing and protected key management

The SDK provides Builder APIs and callback-based signing options. The signing path must not require the application to load a production private key into process memory.

- Use a dedicated signing service or KMS/HSM-backed callback signer.
- Restrict signing permission to approved export jobs and authorized service identities.
- Keep certificate chains and public trust material separate from private signing material.
- Define certificate issuance, key rotation, timestamp authority, revocation checking, trust-list updates, audit retention and emergency key revocation.
- Record the certificate identity and trust-policy version used for each signature.
- Never store private keys in Git, browser code, build artifacts, logs or ordinary environment-variable values.
- Keep signing disabled until a real certificate, protected key provider and operational policy have been reviewed.

## Preserve provenance across transformations

A modified file cannot inherit the source file's signature as if the signature still covered the modified bytes.

For every derivative/export:

1. Retain the immutable source asset ID and checksum.
2. Read the source manifest when present and preserve its ingredient relationship.
3. Add the transformation action and the new output's relevant metadata.
4. Sign a new manifest through the protected signer.
5. Re-open the output with the SDK and verify the newly written manifest.
6. Store the derivative relationship, output checksum, manifest validation result and signing-policy version.
7. If manifest preservation is unsupported or fails, record an explicit provenance discontinuity.

Test the full chain through proxy generation, transcode, timeline render, export and publish. Do not claim continuity merely because the database has a `derivativeOf` pointer.

## Acceptance tests

The feature branch includes deterministic adapter tests for missing manifests, SDK `Valid`/`Invalid`/`Trusted` states, root-anchor and end-entity allowlist policy gating, bounded findings, missing SDK, unknown states, unsupported formats, oversized files and changed on-disk size. Native integration tests use the installed SDK to inspect a valid unsigned PNG, generate actual signed PNG and MP4 media using the official upstream CAI test-only certificate chain, verify it as valid-but-untrusted without a trust policy, verify it as trusted with an explicit end-entity allowlist, and reject altered pixel data. These ephemeral test keys are generated in a temporary directory and are not production signing credentials.

- A known-good signed JPEG/PNG fixture is detected and cryptographically validated.
- A known-good signed supported video fixture is detected and cryptographically validated.
- A byte-tampered fixture is rejected with the SDK's validation findings retained.
- An asset with no manifest is reported as `not_available`, not invalid or trusted.
- A valid signature from a certificate outside the configured trust policy is `valid_untrusted`.
- A valid signature under the configured trust policy is `valid_trusted`.
- Invalid trust anchors, unavailable trust services and SDK load failures never produce a trusted result.
- Oversized, malformed and unsupported files fail safely within resource limits.
- Cross-user and cross-project requests cannot retrieve another tenant's manifest or verification report.
- A derivative has a new manifest, output checksum and ingredient relationship to its source.
- A transformation that cannot preserve provenance reports a discontinuity.
- Production signing cannot be invoked by a browser, viewer role, unapproved job or arbitrary API request.
- Signing and verification events are auditable without logging private key material.

## Current API

```http
GET /api/assets/ASSET_ID/provenance
Cookie: ev_session=...
```

Today this endpoint returns the application integrity record and `c2pa: not_checked`. Keep that distinction until the CAI adapter and the acceptance suite above are implemented and connected.

## Related verification

```bash
npm run verify:provenance
npm run verify:server
```
