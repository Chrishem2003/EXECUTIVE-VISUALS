# Batch 110 — platform-owner margin policy control API

## Enablement

The control plane can be enabled independently of payment processing with
`PLATFORM_MARGIN_POLICY_API_ENABLED=true`. It still requires Supabase authentication
and server-only Supabase credentials. Leave `BILLING_API_ENABLED=false` if payment
processing is not approved; the API health response continues to report billing as
disabled. This environment variable is opt-in and this PR does not change any
deployment environment.

## Endpoints

Both endpoints require an authenticated Supabase account with `platform_admins.role`
equal to `owner` or `platform_admin`. A `billing_admin` role alone is insufficient.

### Read current policy and audit history

`GET /api/admin/finance/platform-video-margin-policy`

Returns the configured policy (or `null` when no policy exists), up to 100 newest
append-only policy history records, and the current dispatch-readiness limitation.
No default threshold is invented.

### Configure or disable the policy

`POST /api/admin/finance/platform-video-margin-policy`

The request body accepts only:

- `enabled`: boolean
- `minimumGrossMarginBps`: integer from 1 to 9500
- `quoteMaxAgeSeconds`: integer from 60 to 3600
- `rateCardMaxAgeSeconds`: integer from 3600 to 3888000

Supply an idempotency key in the request's idempotency header. The server derives
`p_actor_id` from the authenticated account; callers cannot choose another actor.
The API invokes the service-role-only `configure_platform_video_margin_policy` RPC,
which serializes version updates and writes append-only history.

A conflicting reuse of an idempotency key returns HTTP 409. Invalid values or unknown
request fields are rejected before the RPC is called.

## Dispatch safety

The policy control endpoints remain available when payment processing is disabled;
they do not activate billing, payments, providers or generation. Saving an enabled
margin policy does **not** unlock billable generation. The API explicitly reports
`blocked_until_fully_loaded_cost_model_adapter` because preflight still fails closed
until trusted provider estimates, per-shot monetary price evidence and fully-loaded
variable-cost evidence are composed by the server.

No default gross-margin threshold is selected by this batch. The platform owner must
choose the threshold and freshness windows explicitly. No production changes or
provider calls are performed.
