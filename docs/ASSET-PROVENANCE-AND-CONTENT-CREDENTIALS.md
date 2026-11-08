# Asset provenance and Content Credentials

**Status:** application-level integrity records, authenticated CAI Node SDK verification, and signer-injected C2PA preservation hooks for cloud media, local SQLite media, local timeline rendering and cloud timeline rendering are implemented on this branch. Production signing remains disabled pending an approved signer and trust policy.

## What is implemented

On every accepted upload, the API:
1. Streams the file to storage while calculating SHA-256.
2. Validates the media signature and rejects empty/unsupported content.
3. Creates a deterministic `executive-visuals.provenance.v1` record bound to the asset ID, actual SHA-256, media type, byte size, source kind and UTC ingest timestamp.
4. Stores the record in the existing asset metadata and includes the record hash in the upload audit event.
5. Exposes authenticated verification at `GET /api/assets/:assetId/provenance`, protected by the same project/asset access boundary as the asset itself.

The verifier checks the record hash and compares its asset identity, media type, size and content hash with the current asset row. Old assets without a record return `not_available`; they are not silently treated as verified.

## Verification states

- `integrity_verified`: the application record is internally consistent and matches the asset row.
- `invalid`: the record is malformed, altered or no longer matches the asset row.
- `not_available`: no supported application provenance record exists.

The application record is **not** a C2PA Content Credential, digital signature, real-world identity proof, legal rights clearance or factual verification. C2PA is inspected separately through `GET /api/assets/:assetId/c2pa`, which uses the official `@contentauth/c2pa-node` SDK and returns one of `trusted`, `valid_untrusted`, `invalid`, `not_present` or `validation_unavailable`. Only the SDK's explicit `Trusted` validation state is reported as trusted; a cryptographically valid but untrusted signer remains `valid_untrusted`. SHA-256 protects consistency only when the trusted record itself is protected; a privileged attacker who can rewrite both the asset row and record could replace them together.

## Transformation preservation

The same C2PA transformation preserver is now shared by cloud media, local SQLite media, local timeline rendering and cloud timeline rendering. It supports multiple source assets: every source is checked against its registered SHA-256, each credential-bearing source is independently parsed and validated, and each valid source manifest is added as a `parentOf` ingredient to the new output manifest. Sources without embedded credentials are not represented as signed lineage. A remote-only manifest is not fetched and blocks publication rather than being mislabeled as absent.

The preserver creates a new `edit` manifest, adds a `c2pa.edited` action with the operation and source counts, signs to a temporary sibling file, validates the resulting embedded manifest and its ingredient manifest data, rechecks all source and output hashes, and only then atomically replaces the derivative. The output checksum is computed after signing and is the checksum stored with the published asset.

Local operations covered:
- AI upscaling.
- FFmpeg thumbnail, audio extraction/cleanup, proxy, transcode, denoise, color, resize, interpolation and enhancement outputs.
- Local SQLite timeline masters, carrying every enabled video, audio and still-image overlay source as an ingredient.

Cloud operations covered:
- Existing cloud single-source media derivative executor.
- Cloud timeline masters, carrying every materialized video, audio and still-image source asset.

If no source contains an embedded C2PA manifest, the derivative is left unchanged and the result is explicitly `not_present`. If any credential-bearing source is invalid, remote-only, unsupported, or cannot be re-signed because no authorized signer is configured, publication fails closed. This prevents silently dropping known credentials. A failed operation does not publish a derivative.

The signer is dependency-injected as a local or callback signer. No private key, production signer, trust anchor or signing-service credential is configured in this branch. The local and cloud hooks are implementation paths, not production signing enablement. Operators must supply an approved server-side signer before C2PA-bearing transformations can complete.

## API examples

```http
GET /api/assets/ASSET_ID/provenance
Cookie: ev_session=...
```

```http
GET /api/assets/ASSET_ID/c2pa
Cookie: ev_session=...
```

The application-provenance endpoint returns the stored record and its internal integrity result. The C2PA endpoint reads the original stored media using the official native SDK and returns a bounded manifest summary, validation findings and explicit trust state. Both endpoints use the same asset/project authorization check; inaccessible assets return 404.

## C2PA integration path

The verifier pins the maintained CAI Node SDK at `@contentauth/c2pa-node@0.10.0`, requires a patched Node 22 runtime, caps inspection at the application's 250 MiB upload limit, verifies the asset checksum before and after native parsing, disables remote manifest fetching and OCSP network access, and accepts an optional operator-managed local trust-anchor file through `C2PA_TRUST_ANCHORS_PATH`. A missing SDK fails with HTTP 503; it never falls back to treating application provenance as C2PA evidence. Verified in CI:
- The pinned SDK is installed reproducibly from the committed npm lockfile on patched Node 22.23.4.
- A real PNG is signed in-memory with the CAI SDK and upstream public test-only certificate/key, then read back and validated by the same SDK; this is an integration fixture, not a production signing capability.
- Mock-based tests cover trust-state mapping, missing manifests, malformed manifests, checksum mismatches, parser-time mutation, size limits and missing-SDK fail-closed behavior.
- API tests verify authenticated asset access and cross-user isolation.

Remaining production gates:
- Run independent local/cloud transcode, proxy, AI-upscale and timeline round-trip tests against credential-bearing fixtures, including large media and cancellation paths.
- Obtain a suitable production C2PA signing certificate and protect private keys with KMS/HSM-backed signing; never ship private keys to browsers or repository files.
- Define and review the production trust-anchor, certificate-chain, timestamping, revocation and trust-list policy; no production trust anchor is bundled by this feature.
- Keep C2PA validation separate from rights, consent, factual accuracy and editorial approval.

Reference: https://opensource.contentauthenticity.org/docs/
Specification: https://spec.c2pa.org/specifications/specifications/2.5/specs/C2PA_Specification.html

## Acceptance tests

The provenance test suite verifies deterministic record creation, record tampering, media checksum mismatch, invalid input, derived-source requirements, missing legacy records, real CAI-signed manifest parsing, source-ingredient preservation through a second signed transformation, trust-state classification, C2PA asset integrity, cloud derivative fail-closed behavior and API authorization.
