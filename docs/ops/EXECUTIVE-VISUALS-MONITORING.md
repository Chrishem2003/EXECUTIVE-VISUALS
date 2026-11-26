# Operational monitoring and alert delivery

Configure the GitHub `staging` environment:
- Variable `EXECUTIVE_VISUALS_HEALTH_URL`: the selected app health endpoint (staging first; production only after explicit launch approval).
- Secret `OPS_ALERT_WEBHOOK_URL`: an HTTPS incoming webhook compatible with a JSON `text` field (Slack-compatible format).

The workflow runs every 15 minutes and can be manually dispatched to send a synthetic test alert or run a health probe. The probe sends a critical alert for non-2xx responses, invalid JSON, recognized unhealthy statuses, or failed checks. Healthy probes do not send notifications. The webhook URL is never printed.

Initial setup must use the staging app and staging webhook. After a successful real delivery test, an operator may separately approve production monitoring by changing the environment variable. GitHub Actions schedule is best-effort, not a guaranteed uptime monitor or paging SLA; a production service should eventually have an independent external monitor.

No alert delivery is claimed until the manual test-alert workflow reports HTTP 2xx from the configured endpoint.


## Workflow availability and deployment safety
These workflows currently live on a review branch. GitHub manual `workflow_dispatch` and scheduled `schedule` runs require the workflow file to be present on the repository's default branch. Do not merge this PR to `main` solely to unlock testing: the Executive Visuals Render web service automatically deploys commits to `main`. First establish a safe staging execution path or explicitly approve a controlled deployment/configuration change. Until then, the PR-triggered static checks are the only GitHub Actions evidence; the manual runtime acceptance is pending.


## Readiness checks
The monitor rejects malformed health payloads even when HTTP returns 200. Optional GitHub staging environment variables enable launch-readiness assertions:
- `EXECUTIVE_VISUALS_REQUIRE_POSTGRES=true` alerts unless `database=postgres`.
- `EXECUTIVE_VISUALS_REQUIRE_CLOUD_MEDIA=true` alerts unless `cloudMedia.enabled=true` and `cloudMedia.ready=true`.

Keep these flags false for pure liveness monitoring; set them true when the configured endpoint is expected to be launch-ready. The production health endpoint was freshly checked on 2026-11-26: it returned HTTP 200 and `status=ok`, but reported `database=sqlite`, `storage=local-disk`, local uploads disabled, cloud media disabled/not ready, billing disabled, and the cloud video worker disabled. This is an availability response, not launch-readiness evidence. Do not configure production readiness alerts as a substitute for resolving those blockers.
