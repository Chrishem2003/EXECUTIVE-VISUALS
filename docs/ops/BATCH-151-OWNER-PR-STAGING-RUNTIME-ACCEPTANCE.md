# Batch 151 — Owner-PR staging runtime acceptance

## Problem

Several real staging acceptance workflows were manual-only. GitHub `workflow_dispatch` requires the workflow to exist on the default branch, but merging a workflow-only change to `main` would auto-deploy the current Render services. That is not an acceptable way to unlock staging tests.

## Changes

The following safe runtime jobs can now run from same-repository pull requests authored by `Chrishem2003`, when the protected staging environment variable `STAGING_RUNTIME_TESTS_ENABLED=true` is explicitly set:

- Private storage round-trip and cross-tenant denial.
- Worker heartbeat persistence across a child-process crash/restart.
- Paddle Sandbox credential and Pesapal Sandbox token/IPN verification.

Static-contract jobs continue to run on PRs. Runtime jobs remain skipped by default when the opt-in variable is absent or false. Fork PRs do not receive staging secrets.

## Operator activation

1. Configure all required secrets and variables in GitHub Settings → Environments → `staging`.
2. Run/observe strict staging preflight and require `READY`.
3. Review the two disposable test identities and confirm they belong only to the approved staging project.
4. Set `STAGING_RUNTIME_TESTS_ENABLED=true` in the protected staging environment.
5. Open or update an owner-authored PR touching the corresponding acceptance paths; the staging runtime jobs execute without merging to `main`.

The switch is optional and is not itself a readiness credential.

## Deliberately manual workflows

- Encrypted backup export remains manual because it exports staging database/object data and uploads an encrypted artifact.
- Synthetic monitoring alert delivery remains manual because it sends an external notification.
- Neither is automatically triggered by this switch.

## Safety

- Only the approved Supabase staging project ref is accepted by the scripts.
- Storage tests create a random small object and delete it in cleanup.
- Worker tests use synthetic heartbeat rows and a local child process; they do not create a Render worker or submit paid AI jobs.
- Payment tests use Paddle Sandbox read-only endpoints and Pesapal Sandbox authentication/IPN lookup; they do not create checkout or charge a payment method.
- No production migrations, Render deployments, service creation, provider live mode or customer data are involved.
