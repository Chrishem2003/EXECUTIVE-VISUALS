# Asset provenance and Content Credentials

**Status:** application-level integrity records are implemented for new uploads. An authenticated read-only C2PA inspection adapter is implemented using the official CAI Node SDK. C2PA signing and transformation-manifest preservation remain incomplete.

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

The response always reports `c2pa: not_checked`. The application record is **not** a C2PA Content Credential, digital signature, real-world identity proof, legal rights clearance or factual verification. SHA-256 protects consistency only when the trusted record itself is protected; a privileged attacker who can rewrite both the asset row and record could replace them together.

## API example

```http
GET /api/assets/ASSET_ID/provenance
Cookie: ev_session=...
```

The endpoint returns the manifest, a verification result and an explicit limitation notice. Access is denied whenever the caller cannot access the underlying asset.

## C2PA inspection

`GET /api/assets/ASSET_ID/c2pa` is protected by the existing asset access check. The endpoint reads the server-stored file using `Reader.fromAsset` and an explicit MIME type, disables remote manifest fetching, and reports the SDK's explicit `validation_state` only. It never promotes `Valid` to `Trusted`, and it does not infer `Invalid` from individual finding text when the overall state is absent. The SDK's documented `null` reader result is handled as `not_found`; incomplete manifest/state combinations return `indeterminate`. Missing SDK installation is reported as `not_available`.

The Docker build uses Node 24.22.1 (a patched release) and installs the exact `@contentauth/c2pa-node@0.10.0` package. Local developers can install the same package with the command in the README. The SDK's native binary is installed at build time; Rust is not required for the normal package installation.

## Remaining C2PA integration path

Before production signing and lineage preservation:
- Pin and review the SDK release and supported media formats.
- Validate untrusted files with resource limits and safe parser isolation.
- Distinguish missing, invalid, valid and trusted credentials; trust requires an explicit trust policy.
- Preserve ingredient relationships and record transformations in new manifests.
- Obtain a suitable C2PA signing certificate and protect private keys with KMS/HSM-backed signing; never ship private keys to browsers or repository files.
- Record certificate chain, timestamping, revocation/trust-list policy and verification result.
- Keep C2PA validation separate from rights, consent, factual accuracy and editorial approval.
- Add real signed C2PA fixtures from a controlled test certificate and verify them in CI.
- Test metadata survival through transcode, edit, proxy, render and publish workflows.

Reference: https://opensource.contentauthenticity.org/docs/
Specification: https://spec.c2pa.org/specifications/specifications/2.5/specs/C2PA_Specification.html

## Acceptance tests

The provenance test suite verifies deterministic record creation, record tampering, media checksum mismatch, invalid input, derived-source requirements, missing legacy records and the explicit `c2pa: not_checked` boundary. The C2PA adapter suite covers explicit trusted/valid/invalid states, missing manifests, indeterminate validation, absent SDK behavior, null reader results, and MIME/path requirements. A native SDK smoke test also sends a generated valid PNG through the installed native parser and verifies the documented no-manifest result. These tests do not yet replace signed-manifest fixture coverage for trusted, invalid-signature and tampered-asset cases.
