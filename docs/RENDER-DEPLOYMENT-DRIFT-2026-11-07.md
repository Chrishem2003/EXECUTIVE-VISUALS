# Executive Visuals Render deployment audit — 2026-11-07

Read-only inspection of **Chris's workspace**. No Render service, environment variable, deployment, database, or storage configuration was changed.

## Services observed

| Role | Render service | Branch | Plan | Runtime | Latest observed deployment |
|---|---|---|---|---|---|
| Production | `EXECUTIVE-VISUALS` | `main` | Free | Docker / `./Dockerfile` | `18cb97bf027dc5037fc1d932f36dd4d00f6e6c67`, live |
| Separate testing | `EXECUTIVE-VISUALS-1` | `feat/credits` | Free | Docker / `Dockerfile.free` | `22aba4e5b543924ab2f4b679daebacfa4bcb0496`, live |

Production dashboard: https://dashboard.render.com/web/srv-dblblnlg1s2s73e8bl00  
Production URL: https://executive-visuals.onrender.com

Testing dashboard: https://dashboard.render.com/web/srv-dblbnhu417fc7383elmg  
Testing URL: https://executive-visuals-1.onrender.com

Both services are in Frankfurt, each configured for one instance, with automatic deploys enabled. Both currently report no Render health-check path and no persistent disk in their service details. Production's latest deployment was observed live at commit `18cb97bf`; the testing service's latest deployment was observed live at `22aba4e5`.

## Configuration drift

The repository's `render.yaml` describes a different staging service:
- service name `executive-visuals-staging`
- branch `feat/executive-visuals-unified-platform`
- Starter plan
- `/api/health` health check
- 1 GB persistent disk mounted at `/var/data`
- Supabase auth and persistent-data enforcement

That declaration does **not** match either existing Render service listed above. Do not apply the Blueprint or alter service configuration as part of this PR. Reconcile the intended production/staging topology explicitly before any infrastructure change.

## Log observations

- Production's latest deploy log shows the new instance starting and the service reporting live.
- The same deployment window includes `npm error signal SIGTERM` from an instance being terminated during the rolling deploy. This is consistent with shutdown during replacement, not by itself evidence of an application crash.
- Production logs include Node's experimental SQLite warning.
- The testing service's latest observed live deploy is from 2026-11-06, behind production's 2026-11-07 deployment.

The Render request-log query returned no matching `/api/health` request entries for either service. Public health URLs could not be fetched through the available web retrieval path during this audit. Therefore, live health-response status is **not verified here**.

## Release implications

1. Production is deployed on the Free plan without a configured persistent disk in the inspected service metadata. SQLite/local-disk data must not be treated as durable across instance replacement.
2. The existing cloud workspace adapter is opt-in and requires Supabase server-side credentials, Supabase auth, and its cloud schema/storage readiness. The production health response now reports local SQLite and cloud workspace activation separately.
3. The testing deployment is stale relative to production and should be updated only through an explicitly approved staging workflow.
4. Do not merge or deploy this PR automatically. Production remains untouched.

## Safe next actions

- Decide whether `EXECUTIVE-VISUALS` is the production service and `EXECUTIVE-VISUALS-1` is the dedicated staging service.
- Approve a staging-only Supabase/Postgres and private object-storage acceptance test.
- Confirm the required backup/restore procedure and perform a restore drill against isolated test data.
- Configure a health-check path and durable storage only after explicit infrastructure approval.


## Follow-up verification — 2026-11-07 (after initial read-only audit)

A second read-only inspection confirmed:

- Production `EXECUTIVE-VISUALS` remains on `main`, not suspended, with latest observed deploy `18cb97bf027dc5037fc1d932f36dd4d00f6e6c67` marked live.
- The separate `EXECUTIVE-VISUALS-1` service is now **suspended by the user** (Render event at 2026-11-07 09:39:22 UTC). Its branch remains `feat/credits`; latest observed deploy remains `22aba4e5b543924ab2f4b679daebacfa4bcb0496`. It was not resumed or modified.
- Production logs contain historical startup failures because `AUTH_MODE=local` is rejected in production. The latest inspected process started at 09:40:25 UTC and received SIGTERM at 09:55:39 UTC. The service was still marked not suspended; no conclusion about live HTTP health can be drawn from that SIGTERM alone.
- The latest production build log reports 378 tests passed and zero failed, then Vite built successfully. This is build evidence, not proof of live authentication, storage durability, or customer workflow acceptance.
- No request logs were returned for the inspected post-deploy window. External health endpoint retrieval was unavailable, and neither existing Render service has a configured health-check path.
- The connected Supabase projects were inspected read-only. `Chrishem Project` contains NEMA/platform tables and an empty `ev_workspace_snapshots` table but no `executive_visuals` schema. `Chrishem Platform Staging` contains NEMA/platform job tables and no `executive_visuals` schema. Neither is an approved isolated Executive Visuals database; do not apply the new migrations to either project.

The consolidated code candidate is in draft PR #206. Its exact-head quality and Google Drive/PostgreSQL CI runs passed. Production auto-deploys from `main`, so merging PR #206 would trigger production deployment. Keep it draft until the user approves a dedicated isolated database, staging activation, durable storage, required credentials, and acceptance testing.


## Live HTTP health recheck — 2026-11-07

The production public health endpoint was rechecked with a fresh request. The first response was Render `503 Application loading`; after allowing the Free instance to wake, the endpoint returned **HTTP 200** with `status=ok`, `authMode=supabase`, `storage=local-disk`, `database=sqlite`, and FFmpeg/FFprobe available. The image and text gateways reported disabled/unconfigured.

This updates the earlier note that external health could not be verified. Current public health is now verified as HTTP 200 after wake-up. The historical `AUTH_MODE=local` startup errors are not the current reported auth mode. However, local-disk/SQLite remains the active storage backend and no persistent disk is configured, so durable customer data is still not release-safe. The first 503 followed by 200 after a 12-second wake allowance is consistent with Render Free instance sleep behavior. No service configuration was changed.
