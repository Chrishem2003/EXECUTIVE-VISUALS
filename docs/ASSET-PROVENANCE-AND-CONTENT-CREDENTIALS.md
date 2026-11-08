# Asset provenance and Content Credentials

**Status:** application-level asset integrity records implemented for new local uploads. C2PA verification/signing is not implemented by this feature.

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

## C2PA integration path

A separate future adapter should use the Content Authenticity Initiative's maintained SDK for Node.js (`@contentauth/c2pa-node`) or an appropriate C2PA CLI for offline inspection. Before production signing:
- Pin and review the SDK release and supported media formats.
- Validate untrusted files with resource limits and safe parser isolation.
- Distinguish missing, invalid, valid and trusted credentials; trust requires an explicit trust policy.
- Preserve ingredient relationships and record transformations in new manifests.
- Obtain a suitable C2PA signing certificate and protect private keys with KMS/HSM-backed signing; never ship private keys to browsers or repository files.
- Record certificate chain, timestamping, revocation/trust-list policy and verification result.
- Keep C2PA validation separate from rights, consent, factual accuracy and editorial approval.
- Test metadata survival through transcode, edit, proxy, render and publish workflows.

Reference: https://opensource.contentauthenticity.org/docs/
Specification: https://spec.c2pa.org/specifications/specifications/2.5/specs/C2PA_Specification.html

## Acceptance tests

The provenance test suite verifies deterministic record creation, record tampering, media checksum mismatch, invalid input, derived-source requirements, missing legacy records and the explicit `c2pa: not_checked` boundary.
