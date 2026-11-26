# Cloud worker process restart acceptance

Run the manual `Cloud worker process restart acceptance` workflow against the GitHub `staging` environment only.

Required secret values:
- `SUPABASE_STAGING_URL`: staging project URL.
- `SUPABASE_STAGING_SECRET_KEY`: staging-only Supabase secret/service-role key permitted to execute the heartbeat RPC.

The script starts a child process that writes starting and healthy heartbeat records, forcibly terminates it (simulating abrupt host/process loss), starts a second process with a distinct worker ID, verifies its starting/healthy records, and gracefully stops it while writing stopped.

This is a process-level liveness/restart acceptance test. It does not provision a Render Background Worker, execute customer jobs, or prove queue lease recovery by itself. Queue lease fencing/recovery remains covered by the separate PostgreSQL worker integration and job-queue tests.

Never use production credentials. The workflow prints worker IDs and statuses only, never credentials.


## Workflow availability and deployment safety
These workflows currently live on a review branch. GitHub manual `workflow_dispatch` and scheduled `schedule` runs require the workflow file to be present on the repository's default branch. Do not merge this PR to `main` solely to unlock testing: the Executive Visuals Render web service automatically deploys commits to `main`. First establish a safe staging execution path or explicitly approve a controlled deployment/configuration change. Until then, the PR-triggered static checks are the only GitHub Actions evidence; the manual runtime acceptance is pending.
