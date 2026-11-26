# Operational monitoring and alert delivery

Configure the GitHub `staging` environment:
- Variable `EXECUTIVE_VISUALS_HEALTH_URL`: the selected app health endpoint (staging first; production only after explicit launch approval).
- Secret `OPS_ALERT_WEBHOOK_URL`: an HTTPS incoming webhook compatible with a JSON `text` field (Slack-compatible format).

The workflow runs every 15 minutes and can be manually dispatched to send a synthetic test alert or run a health probe. The probe sends a critical alert for non-2xx responses, invalid JSON, recognized unhealthy statuses, or failed checks. Healthy probes do not send notifications. The webhook URL is never printed.

Initial setup must use the staging app and staging webhook. After a successful real delivery test, an operator may separately approve production monitoring by changing the environment variable. GitHub Actions schedule is best-effort, not a guaranteed uptime monitor or paging SLA; a production service should eventually have an independent external monitor.

No alert delivery is claimed until the manual test-alert workflow reports HTTP 2xx from the configured endpoint.
