# Staging configuration preflight

This check inventories the protected GitHub `staging` environment without calling Supabase, Neon, Render, Paddle, Pesapal or an alert provider. It prints only missing/invalid variable names and a readiness state; it never prints credential values.

- `READY`: required staging values are present and basic project/sandbox/URL constraints pass. This is configuration readiness only, not runtime acceptance.
- `BLOCKED`: one or more required values are absent. The preflight exits successfully so missing operator configuration is not misreported as an application test failure. The output names the missing settings.
- `INVALID`: a supplied value violates a safety check (wrong Supabase project ref, non-HTTPS endpoint, malformed owner UUID, live/non-sandbox Paddle marker, or short backup passphrase). This exits non-zero.

The approved staging project ref is `bokxljngydmqrmktofwm`. It is the existing shared `Chrishem Platform Staging` Supabase project, not an isolated production data plane. No migration or data change is performed by this preflight.

Runtime acceptance remains separate:
- Storage round-trip and cross-tenant isolation.
- Worker heartbeat persistence and process restart.
- Encrypted schema/object export and independent restore.
- Alert delivery.
- Paddle/Pesapal sandbox authentication and webhook lifecycle.

A `READY` preflight must never be treated as proof that these runtime checks passed. The tests use placeholder values only and do not perform network calls.
