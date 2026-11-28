# Staging configuration preflight

This check inventories the protected GitHub `staging` environment without calling Supabase, Neon, Render, Paddle, Pesapal or an alert provider. It prints only missing/invalid variable names and a readiness state; it never prints credential values.

- `READY`: all required staging values are present and basic project, sandbox, identity and URL constraints pass. This is configuration readiness only, not runtime acceptance.
- `BLOCKED`: one or more required values are absent.
- `INVALID`: one or more supplied values violate a safety check (wrong Supabase project ref, non-HTTPS endpoint, malformed owner UUID, live/non-sandbox Paddle marker, invalid Pesapal callback or short backup passphrase).

The script supports report-only mode for local diagnostics and strict mode (`--require-ready`) for launch gates. The GitHub staging preflight uses strict mode and exits non-zero unless the state is exactly `READY`; a missing secret can no longer appear as a successful readiness check.

The approved staging project ref is `bokxljngydmqrmktofwm`. It is the existing shared `Chrishem Platform Staging` project, not an isolated production data plane. No migration or data change is performed by this preflight.

Runtime acceptance remains separate:
- Private storage round-trip and cross-tenant isolation.
- Worker heartbeat persistence and process restart.
- Encrypted database/private-object export and independent restore.
- Real alert delivery.
- Paddle/Pesapal sandbox authentication, checkout, webhook/IPN and reconciliation.

A `READY` preflight must never be treated as proof that these runtime checks passed.
