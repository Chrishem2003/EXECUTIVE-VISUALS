# Batch 150 — Subscription billing runtime schema gate

## Risk addressed

The Paddle/Pesapal configuration readiness check previously considered the database ready when only a Supabase URL and server key were present. That did not prove the target project contained the provider billing tables, webhook lease functions, reconciliation records or owner remediation controls. A production project with incomplete migrations could therefore appear configured while failing only when a customer reached checkout or a webhook arrived.

## Implementation

### Database capability function

Migration `20261128160000_subscription_billing_runtime_schema_gate_batch_150.sql` adds `executive_visuals.check_subscription_billing_runtime_schema()`.

It is a read-only SECURITY DEFINER function with a fixed `search_path`. It verifies:
- Required provider-price, subscription, payment, webhook and financial reconciliation/remediation tables exist.
- RLS is enabled on each required table.
- `anon` and `authenticated` have no direct SELECT/INSERT/UPDATE/DELETE grants on those tables.
- `service_role` can read the required tables.
- Required provider purchase, renewal, webhook claim, lifecycle and financial review RPCs exist.
- Required RPCs are executable by `service_role` and not executable by client roles.

Only `service_role` can execute the capability function.

### Runtime gate

The server now calls the capability RPC before constructing the Paddle/Pesapal billing service. The probe:
- Uses the server-side Supabase key and the `executive_visuals` schema profile.
- Has a bounded timeout and a 16 KiB response limit.
- Requires `ready=true`, schema `executive_visuals`, version `batch-150`, and an empty missing list.
- Fails closed on missing RPC, HTTP error, malformed response, timeout or missing schema objects.
- Never returns or logs credentials.

When the gate is not READY, the server still starts, but provider billing remains unavailable and webhook routes return the existing disabled response. The health endpoint reports the sanitized configuration and schema-gate state.

## CI acceptance

The billing self-service PostgreSQL workflow applies Batch 150 after Batches 146 and 147, then verifies:
- Full capability report is READY against the disposable PostgreSQL schema.
- The function is SECURITY DEFINER with fixed search path.
- `service_role` can execute it.
- `anon` and `authenticated` cannot execute it.
- Provider billing unit tests cover READY, missing RPC, missing table/grant report, missing credentials and credential non-disclosure.

## Deployment status and safety

- CI uses an ephemeral PostgreSQL 16 service container; this is not a production or Neon deployment.
- No migration is applied to Supabase staging or production by this batch.
- No Paddle/Pesapal provider call, checkout, charge, refund or subscription change occurs.
- No Render service or environment variable is changed.
- Production billing cannot become available merely because API keys exist; the Batch 150 schema capability must also be present and pass.
