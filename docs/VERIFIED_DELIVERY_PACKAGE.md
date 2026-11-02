# Verified Delivery Package Contract

**Status:** implemented on `feat/timeline-preview-transport`; CI and staging verification pending.

## Purpose

A delivery package is a portable, fingerprinted evidence handoff for one completed cloud timeline render. It is not a replacement for the original private media asset, the append-only review events, or the render job record.

## API

`GET /api/cloud/jobs/:jobId/delivery-package`

The endpoint requires an authenticated project reader and a succeeded `timeline.render` job. It fails closed unless:

1. The delivery receipt fingerprint verifies.
2. The receipt timeline ID and revision match the render input.
3. The receipt output asset and checksum match the render output.
4. The private asset repository returns the same project asset, byte size, media type and checksum.
5. The signed download ticket references that exact asset and checksum.
6. The signed URL is HTTPS and contains no embedded credentials or fragment.

The signed master link expires after 300 seconds. It must be treated as a bearer capability and must not be copied into logs, analytics, public metadata or long-lived records.

## Package contents

- Package schema version and package type.
- Job, project, timeline and revision identifiers.
- Master asset ID, filename, media type, byte size and SHA-256.
- Five-minute private master download URL.
- Immutable delivery receipt and its fingerprint.
- Verified render manifest.
- Delivery profile validation report.
- Rendered-media quality report, including decoded-frame luminance findings, sample count, coverage and explicit unavailable/partial-analysis warnings.
- Review decisions scoped to the exact receipt fingerprint.
- Canonical SHA-256 package fingerprint.

`createDeliveryPackage` validates the contract and `verifyDeliveryPackage` verifies the package after JSON serialization/transport. The package fingerprint detects changes; it binds the quality report as evidence but does not prove that a human reviewer agrees with its heuristics. It does not replace the receipt's asset checksum or prove human visual quality.

## User workflow

The timeline delivery-review panel offers **Build verified delivery package**. The JSON handoff is downloaded, and the master link is rendered as a separate explicit user action to avoid popup blockers and accidental navigation after an asynchronous request. The UI keeps the short-lived URL only in page memory.

## Current limitations

- This is a JSON evidence handoff plus private master download, not a ZIP archive.
- The link expires after five minutes; request a fresh package to obtain a new one.
- Human review remains a separate, append-only action.
- Technical profile conformance is not a subjective quality certification.
- The Supabase uniqueness migration is not applied by this implementation.
- No production deployment or paid-provider execution is implied.

## Verification gates

- Unit tests cover package fingerprint creation, JSON round-trip verification, tampering and unsafe URLs.
- API tests cover master checksum mismatch, signed-ticket asset mismatch and unauthorized project access.
- Before release: run the full CI suite on the current head, inspect migration compatibility and existing duplicate review rows, verify private storage behavior in staging, and test download expiry and authorization with separate project roles.
