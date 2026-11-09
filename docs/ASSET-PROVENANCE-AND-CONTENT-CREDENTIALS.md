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

The application-provenance endpoint returns the stored record and its internal integrity result. The C2PA endpoint reads the original stored media using the official native SDK and returns a bounded manifest summary, validation findings and explicit trust state. Both endpoints use the same asset/project authorization check; inaccessible assets return 404. The visual Asset Library exposes an **Inspect Content Credentials** action on image, audio and video asset cards. It displays the verification state, manifest summary, embedded source ingredients, findings, validation details and verified asset checksum without conflating signature validity with signer trust.

## C2PA integration path

The verifier pins the maintained CAI Node SDK at `@contentauth/c2pa-node@0.10.0`, requires a patched Node 22 runtime, caps inspection at the application's 250 MiB upload limit, verifies the asset checksum before and after native parsing, disables remote manifest fetching and OCSP network access, and accepts an optional operator-managed local trust-anchor file through `C2PA_TRUST_ANCHORS_PATH`. A missing SDK fails with HTTP 503; it never falls back to treating application provenance as C2PA evidence. Verified in CI:
- The pinned SDK is installed reproducibly from the committed npm lockfile on patched Node 22.23.4.
- A real PNG is signed in-memory with the CAI SDK and upstream public test-only certificate/key, then read back and validated by the same SDK; this is an integration fixture, not a production signing capability.
- Mock-based tests cover trust-state mapping, missing manifests, malformed manifests, checksum mismatches, parser-time mutation, size limits and missing-SDK fail-closed behavior.
- API tests verify authenticated asset access and cross-user isolation.

Remaining production gates:
- Verify actual Real-ESRGAN model inference end-to-end and run real near-limit large-file throughput/memory stress; the local AI-upscale job path currently passes with a deterministic test-only Lanczos adapter. Other tests cover local SQLite transcode, local timeline with signed video/audio/overlay ingredients, all six application media formats, oversize preflight and cancellation recovery.
- Implement and independently verify a provider-specific KMS/HSM adapter using non-exportable keys, workload identity, certificate matching, signature encoding, rotation, revocation, timestamping and audit evidence. The provider-neutral CAI CallbackSigner adapter is implemented and tested; no real KMS/HSM provider is configured.
- Run isolated staging acceptance with a dedicated non-production signer and approved trust anchors before enabling any deployed signing path.
- Keep C2PA validation separate from rights, consent, factual accuracy and editorial approval.

Reference: https://opensource.contentauthenticity.org/docs/
Specification: https://spec.c2pa.org/specifications/specifications/2.5/specs/C2PA_Specification.html

## Acceptance tests

The provenance test suite verifies deterministic record creation, record tampering, media checksum mismatch, invalid input, derived-source requirements, missing legacy records, real CAI-signed manifest parsing, source-ingredient preservation through a second signed transformation, trust-state classification, C2PA asset integrity, cloud derivative fail-closed behavior and API authorization.


## In-app milestone visibility

The browser app now includes **Manage → Trust & provenance**, a concise evidence ledger showing completed implementation stages, the exact verification scope, and release gates that remain open. It links to the Asset Library's authenticated per-asset inspection panel, PR #249 and CI evidence. The page does not equate a valid signature with trusted identity, rights clearance or factual accuracy, and does not represent an unconfigured KMS/HSM or staging environment as complete.

A 96 MiB streaming preservation stress test now exercises file-backed copy, streamed checksum verification, ingredient validation and final output integrity. The near-limit performance/memory profile remains a separate release gate.


The Asset Library only offers direct C2PA inspection for media types covered by the current app/CAI overlap (JPEG, PNG, WebP, GIF, MP3, WAV, M4A, MP4 and MOV). For app-ingestible WebM, MKV and OGG assets, the UI explicitly says C2PA inspection is unsupported by the current format matrix instead of presenting a misleading inspection action. The API independently enforces the same supported MIME-type matrix and returns `validation_unavailable` with `C2PA_FORMAT_UNSUPPORTED` for unsupported media, rather than invoking the native reader or misclassifying an unsupported format as invalid credentials. These ingest formats remain outside the C2PA signing/preservation claim until a supported SDK path is tested.
