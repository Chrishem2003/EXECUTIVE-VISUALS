# Batch 147 — Owner subscription finance command centre

## Purpose

Batch 147 makes Batch 146's read-only subscription reconciliation operationally visible to authorized finance administrators. It adds currency-separated subscription cash and recurring run-rate summaries, credit-unit visibility, durable finding history, and a two-person approval trail for manual investigations.

## Implemented

### Owner finance API

- `GET /api/admin/finance/subscription-reconciliation?limit=20` — recent durable runs and their bounded finding snapshots.
- `POST /api/admin/finance/subscription-reconciliation/run` — trigger a read-only reconciliation (limit 1–500).
- `GET /api/admin/finance/subscription-liabilities` — subscription MRR run-rate, past-due face amounts, successful Paddle/Pesapal subscription cash, refunds, cycle credits, and credit-unit balances.
- `GET /api/admin/finance/subscription-remediations?limit=50` — review requests and append-only decision events.
- `POST /api/admin/finance/subscription-remediations` — create a review request tied to a specific reconciliation run and finding index.
- `POST /api/admin/finance/subscription-remediations/{id}/decision` — approve for manual review or reject.

The APIs require a verified account and an allowlisted finance administrator. Creating and deciding remediation requests require the platform owner or platform administrator role. The database functions independently verify these roles.

### Owner UI

The Financial Command Centre now includes a Subscription Control Tower with:
- Active/trialing and past-due subscription counts.
- Currency-separated MRR run-rate, past-due face amounts, subscription cash, refunds and net cash.
- Available, reserved, gross outstanding and pending subscription-split credit units.
- Latest reconciliation run and findings.
- Manual run and report refresh actions.
- Controlled review request creation and approval/rejection history.

### Credit liability semantics

The dashboard deliberately reports credit units separately from monetary values. Pending subscription allowance credits are not converted into a cash liability until an authorized finance review approves a supported allocation. `monetaryLiabilityCalculated=false` is explicit in the API response.

MRR is a normalized run-rate: monthly plan amount as-is and annual plan amount divided by 12. It is not cash collected. Past-due face value is not represented as guaranteed receivables. Currency totals are never combined.

### Two-person approval control

A review request is tied to the exact run and finding snapshot. It records the proposed review action, reason, requester, independent decision-maker, decision reason and immutable event history.

- The requester cannot approve their own request.
- Only a different platform owner/platform administrator can approve or reject.
- Approval means **approved for manual investigation only**.
- Approval does not call a payment provider, grant/revoke credits, change subscription status, mark a payment successful/failed, issue refunds or execute any financial correction.
- Event history is append-only at the database layer.

### Scheduled reconciliation

The migration does not enable extensions or provision services. If the `cron` schema already exists (Supabase `pg_cron` is enabled), it attempts to install an hourly read-only reconciliation job named `executive-visuals-subscription-financial-reconciliation`. If `pg_cron` is unavailable or scheduling is denied, the migration records a notice and manual reconciliation remains available.

For a Supabase staging project where Cron is approved, enable the Cron module under Integrations, then inspect:
```sql
select jobid, jobname, schedule, command, active
from cron.job
where jobname = 'executive-visuals-subscription-financial-reconciliation';

select *
from cron.job_run_details
where jobid = (
  select jobid from cron.job
  where jobname = 'executive-visuals-subscription-financial-reconciliation'
)
order by start_time desc
limit 20;
```

Do not put the Supabase service-role key in browser code or a cron command. The scheduled SQL invokes the database function directly and does not require an HTTP secret.

## CI acceptance

The Billing self-service workflow:
1. Applies Batch 147 after Batch 146.
2. Verifies the liability summary and currency/credit-unit semantics.
3. Creates a real finding from a disposable successful-but-unapplied payment marker.
4. Creates a remediation request.
5. Verifies requester self-approval is rejected.
6. Verifies a different platform administrator can approve for manual review.
7. Verifies approval did not repair the payment marker.
8. Verifies remediation event history cannot be updated.
9. Runs Node API authorization and route tests.

The PostgreSQL integration script wraps all fixture changes in a transaction and rolls them back.

## Deployment and safety boundaries

- No staging or production migration is applied by CI.
- No PR is merged and no Render service is deployed by this batch.
- No live billing is enabled.
- No provider call, charge, refund, credit grant/revocation or subscription mutation is initiated.
- A successful disposable PostgreSQL test is not proof that the live staging project has Cron enabled or that Render is configured to call these APIs.
