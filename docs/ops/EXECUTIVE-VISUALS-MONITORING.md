# Operational monitoring and alert delivery

Configure the GitHub `staging` environment:
- Variable `EXECUTIVE_VISUALS_HEALTH_URL`: the selected app health endpoint (staging first; production only after explicit launch approval).
- Secret `OPS_ALERT_WEBHOOK_URL`: an HTTPS incoming webhook compatible with a JSON `text` field (Slack-compatible format).

The workflow runs every 15 minutes and can be manually dispatched to send a synthetic test alert or run a health probe. The probe sends a critical alert for non-2xx responses, invalid JSON, oversized responses, recognized unhealthy statuses, or failed checks. Healthy probes do not send notifications.

## Delivery and safety controls

- Both endpoints must use HTTPS and cannot contain embedded credentials, query parameters or fragments.
- Requests reject redirects rather than forwarding secrets to a different host.
- Health responses are capped at 64 KiB; webhook responses are capped at 4 KiB.
- Response bodies are never copied into operator logs or alert payloads.
- Alert payloads include only the endpoint host, status summary, bounded check names and a sanitized error code.
- Network requests have a 15-second timeout.
- CI tests synthetic alert delivery, healthy/no-alert behavior, unhealthy/alert behavior, malformed/oversized health responses, endpoint validation and webhook failure handling.

Initial setup must use the staging app and staging webhook. After a successful real delivery test, an operator may separately approve production monitoring by changing the environment variable. GitHub Actions schedule is best-effort, not a guaranteed uptime monitor or paging SLA; a production service should eventually have an independent external monitor.

No alert delivery is claimed until the manual test-alert workflow reports HTTP 2xx from the configured endpoint. The workflow's scheduled health check is not a substitute for an external independent monitor.
