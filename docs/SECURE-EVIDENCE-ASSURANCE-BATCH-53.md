# Secure Evidence Attachments — Batch 53

## Delivered

Batch 53 moves the remediation evidence workflow from manually asserted metadata to actual managed asset attachments.

- The Financial Command Centre accepts PDF, PNG and JPEG evidence files up to 10 MiB.
- The browser uploads file bytes through the existing authenticated `POST /api/assets` endpoint; it does not send a caller-supplied file URL or checksum as proof.
- Existing server-side upload handling enforces a streaming byte limit, creates a server-generated UUID storage name, calculates SHA-256 from the received bytes, and checks the file signature against the declared media type.
- The remediation API accepts only an existing asset owned by the submitting user and scoped to the exact same project (or personal account) as the remediation.
- Evidence is limited to the supported MIME/extension pairs and 10 MiB. Caller-supplied `uri` and `sha256` fields are ignored; the evidence record stores an internal `asset://<id>` reference and the SHA-256 value read from the managed asset record.
- The evidence attachment, action revision increment, history event and audit event are committed in one SQLite immediate transaction with compare-and-set protection.
- Evidence cards expose an authenticated asset download link, original filename, media type, size and server-recorded hash state.
- If attaching an uploaded asset fails, the UI attempts to delete the orphaned asset.
- Legacy metadata-only evidence records remain readable and are not silently upgraded or treated as uploaded files.

## Security controls and limitations

The upload endpoint already enforces authenticated project write access, an allowlist of media types, request-size limits, generated storage names, streaming size enforcement, server-side SHA-256 calculation, file signature checks and safe storage under the configured media root.

**Malware scanning is not configured.** New evidence records explicitly expose `scanStatus: not_scanned`. A successful signature check and SHA-256 calculation do not establish that a file is malware-free, trustworthy, authentic, legally usable or substantively correct. Users should attach only trusted evidence. Do not describe this batch as antivirus-scanned or content-disarmed.

The media root is the existing application storage path. This batch does not create durable object storage or a new backup/retention guarantee. On hosts with ephemeral filesystems, evidence bytes can be lost on restart or redeploy. Production evidence retention remains blocked until the operator verifies and configures persistent storage or an approved private object-storage backend and tests restore.

OWASP recommends an allowlist, content/signature checks, generated filenames, size limits, authenticated authorization, storage outside the webroot or on a separate host, and malware scanning/CDR where applicable: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html.

## Verification

Focused workflow:
- `npm run verify:control-remediation-api`
- `npm run verify:control-remediation`
- `node --check server/control-remediation-api.mjs`
- `npm run typecheck`

New regression coverage checks:
- Correct project/account scope and uploader ownership.
- Unsupported extension/media combinations and files over 10 MiB.
- No caller-controlled URI or SHA-256 override.
- Stored asset SHA-256 is used in the evidence record.
- Evidence revision increments and scan status remains explicitly `not_scanned`.

Focused GitHub Actions workflow **passed** on commit `d53a855a9679201a0ac504c15b4cd92a3304bcde`: remediation API and role-boundary tests, lifecycle tests, API syntax check and Financial Command Centre TypeScript check all succeeded. Run: https://github.com/Chrishem2003/EXECUTIVE-VISUALS/actions/runs/42880581355.

## Release boundary

Branch: `feat/secure-evidence-assurance-batch-53`, based on Batch 52 commit `6be422542084eacc355e53a4ece0b512360993dc`.

Draft-only increment. No merge, production deployment, migration, new paid infrastructure, payment, journal, subscription, entitlement or production configuration change.
