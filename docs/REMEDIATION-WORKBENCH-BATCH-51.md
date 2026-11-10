# Remediation Workbench — Batch 51

## Delivered

Batch 51 connects the persistent remediation API from Batch 50 to the Financial Command Centre.

- Lists persisted remediation actions and displays status, severity, accountable owner, deadline, evidence count, revision and history.
- Converts eligible governance findings into personal remediation records.
- Defaults a personal record's accountable owner to the authenticated creator; callers cannot choose another account as the personal owner.
- Adds controlled status actions: start work, submit for independent review, and display the separate-review requirement for pending actions.
- Records evidence metadata (label, evidence kind, capture date and optional SHA-256 string).
- Exports the current register as a JSON file.
- Adds loading-error visibility rather than silently presenting a failed register request as an empty register.
- Adds responsive workbench styling and regression coverage for personal accountable-owner defaults.

## Evidence and security boundary

The workbench deliberately does not accept file uploads or treat a caller-entered checksum as proof of file integrity. Evidence records created here contain metadata only. Private object storage, server-side content hashing, file signature/type validation, malware scanning, retention and authorized download remain separate release gates.

This follows the OWASP File Upload guidance: use allowlisted file types, validate content rather than trusting the browser MIME type, generate server-side names, enforce size limits, authorize uploads, store files outside the web root or on a separate host, and scan content where appropriate. See https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html.

## Workflow limits

Personal actions are owned by their authenticated creator. A personal action can be progressed and submitted for review after evidence metadata is recorded, but it cannot be independently verified without a separate reviewer in a shared project workflow. The UI explains this boundary rather than offering a self-approval control.

No payment, refund, journal, subscription, account role, identity-provider entitlement or production configuration is modified by this workbench.

## Verification

- Updated `server/tests/control-remediation-api-batch-50.test.mjs` to cover personal creator ownership.
- Existing build gate includes `npm run verify:control-remediation-api`, `npm run verify:control-remediation` and the broader application type-check/build.
- The GitHub workflow has not yet been observed running against this stacked feature PR. Do not interpret the source updates as a passing CI result.
- A local build could not be run in this environment because the GitHub remote could not be resolved by the shell runtime.

## Release status

Branch: `feat/remediation-workbench-batch-51`, based on `feat/persistent-remediation-operations-batch-50`.

This is a draft review increment. It has not been merged, deployed, or applied to production. Before release, run the API regression suite and type-check, inspect the PR diff, validate the finance workspace in a staging browser, and test account isolation and independent-review behaviour with separate test accounts.
