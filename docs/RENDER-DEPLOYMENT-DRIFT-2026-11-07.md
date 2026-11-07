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
