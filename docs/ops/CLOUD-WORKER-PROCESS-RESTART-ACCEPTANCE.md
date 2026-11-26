# Cloud worker process restart acceptance

Run the manual `Cloud worker process restart acceptance` workflow against the GitHub `staging` environment only.

Required secret values:
- `SUPABASE_STAGING_URL`: staging project URL.
- `SUPABASE_STAGING_SECRET_KEY`: staging-only Supabase secret/service-role key permitted to execute the heartbeat RPC.

The script starts a child process that writes starting and healthy heartbeat records, forcibly terminates it (simulating abrupt host/process loss), starts a second process with a distinct worker ID, verifies its starting/healthy records, and gracefully stops it while writing stopped.

This is a process-level liveness/restart acceptance test. It does not provision a Render Background Worker, execute customer jobs, or prove queue lease recovery by itself. Queue lease fencing/recovery remains covered by the separate PostgreSQL worker integration and job-queue tests.

Never use production credentials. The workflow prints worker IDs and statuses only, never credentials.
