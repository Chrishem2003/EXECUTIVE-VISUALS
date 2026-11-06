# Render Deployment Readiness — Executive Visuals

**Assessment date:** 2026-11-06  
**Scope:** Read-only inspection of the connected Render workspace and repository configuration.  
**Safety:** No service settings, environment variables, deployments, databases, disks, or production data were changed or read. Secret values were not requested.

## Executive finding

The connected Render workspace currently exposes two services for this repository, but neither is named `executive-visuals-staging`. The repository Blueprint describes a staging service that does not match the live service inventory. The intended staging target and the production/staging role of the existing services must be explicitly confirmed before any deployment or configuration change.

## Observed service inventory

| Render service | Connected branch | Plan / instances | Auto deploy | Dockerfile | HTTP health path |
|---|---|---|---|---|---|
| `EXECUTIVE-VISUALS-1` | `feat/credits` | Free / 1 | On commit | `Dockerfile.free` | Not configured |
| `EXECUTIVE-VISUALS` | `main` | Free / 1 | On commit | `Dockerfile` | Not configured |

Both services are in Frankfurt and expose a public Render subdomain. The assessment did not infer whether either service is production or staging.

## Repository Blueprint drift

The inspected `render.yaml` on `main` describes:

- Service name: `executive-visuals-staging`
- Branch: `feat/executive-visuals-unified-platform`
- Plan: `starter`
- Dockerfile: `Dockerfile`
- Health check: `/api/health`
- Persistent disk mounted at `/var/data`
- SQLite database and media roots configured beneath `/var/data`
- Supabase authentication mode

No service with that name/branch/configuration appeared in the connected Render service inventory. The live `EXECUTIVE-VISUALS-1` service instead uses `feat/credits`, the Free plan and `Dockerfile.free`. That Dockerfile explicitly places application data under `/tmp/ev-data` and states that it is lost on restart/redeploy. This topology must not be treated as durable production media/database storage.

Render's current documentation states that persistent disks are accessible to one service instance and prevent scaling that disk-backed service to multiple instances. Render recommends managed Postgres or Key Value where appropriate. See https://render.com/docs/disks and https://render.com/docs/scaling.

## Main-branch build blocker

The connected `EXECUTIVE-VISUALS` service tracks `main` and uses `Dockerfile`. Its recent deploy history contains repeated failed builds. The inspected build log identifies the exact failure:

```
COPY package.json package-lock.json ./
...
"/package-lock.json": not found
```

The `main` branch tree did not contain `package-lock.json`. The manifest's name, version, devDependencies and Rollup override were compared with the existing lockfile from `feat/credits`; the package name/version and devDependencies match. A separate draft-only remediation was opened as PR #159 to add the lockfile to `main`. It does not change the connected service until deliberately merged and subsequently deployed.

PR: https://github.com/Chrishem2003/EXECUTIVE-VISUALS/pull/159

## Runtime evidence and limitations

- `EXECUTIVE-VISUALS-1` has a successful live deploy on commit `22aba4e5b543924ab2f4b679daebacfa4bcb0496`; application logs show the API listening on port 10000 and Render reporting the service live.
- Its logs also include Node's experimental SQLite warning. This is a runtime warning, not evidence of data corruption.
- Recent deploys for `EXECUTIVE-VISUALS` on `main` failed during Docker build because the lockfile was missing.
- Render metrics returned empty time series for the inspected window; no performance conclusion can be drawn.
- Public HTTP health endpoint verification was not completed in this assessment.
- The Render environment-variable values were not read.
- The live services' data retention, backup, Supabase Auth configuration, cookie flags, and CORS settings have not been verified from live environment state.

## Required acceptance actions

1. Confirm which service is the intended staging environment and which, if any, is production.
2. Reconcile Render service settings with the intended Blueprint, including branch, Dockerfile, plan, health-check path, auth mode and durable storage.
3. For any environment expected to retain user media or SQLite data, do not rely on `/tmp`; establish the approved persistent or managed storage architecture.
4. Configure an HTTP health-check path only after verifying that `/api/health` is fast, side-effect free and correctly represents readiness. Render requires a 2xx/3xx response within five seconds.
5. Set deploy behavior to wait for CI checks to pass, rather than deploying every commit, where supported and appropriate.
6. Verify Secure cookie behavior, exact CORS allowlist, Supabase session lifecycle and secret presence without disclosing secret values.
7. Verify backups and restore procedures before accepting persistent user data.
8. After explicit staging-target confirmation, deploy only a reviewed commit to that staging service, monitor the deploy to `live`, and run authenticated smoke tests with dedicated test accounts.
9. Do not enable horizontal scaling for a disk-backed SQLite service. Complete the approved Postgres/shared-object-storage migration before multi-instance deployment.

## Release decision

**Not ready for production acceptance based on currently available evidence.** This is an evidence gap and configuration-drift finding, not a claim that either currently running service is compromised. The existing services were left untouched.
