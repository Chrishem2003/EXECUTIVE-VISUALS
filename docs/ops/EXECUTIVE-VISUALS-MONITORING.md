# Operational monitoring and alert delivery

Configure the GitHub `staging` environment:
- Variable `EXECUTIVE_VISUALS_HEALTH_URL`: an HTTPS application health endpoint.
- Secret `OPS_ALERT_WEBHOOK_URL`: an HTTPS incoming webhook compatible with a JSON `text` field.

The workflow runs every 15 minutes and can be manually dispatched to send a synthetic test alert or run a health probe. The test alert must receive HTTP 2xx before delivery is reported as confirmed.

## Probe behavior
- Health endpoint and alert webhook must be valid HTTPS URLs without embedded credentials.
- Redirects are rejected to avoid forwarding requests or secrets to an unapproved destination.
- Health responses are limited to 64 KiB; webhook response bodies are limited to 2 KiB and never logged.
- A response is healthy only when it explicitly reports `ok: true` or a recognized `healthy`, `ok` or `ready` status, with no failed checks.
- Non-2xx responses, invalid JSON, ambiguous/unhealthy status, failed checks, oversized responses and network errors trigger a critical alert.
- Alert payloads contain only the app host, event metadata, timestamp and bounded failure details; no customer data, credentials or webhook response body is included.

Initial setup must use the staging app and staging webhook. After a successful real delivery test, an operator may separately approve production monitoring by changing the protected environment configuration.

GitHub Actions schedule is best-effort, not a guaranteed uptime monitor or paging SLA. A production service should eventually have an independent external monitor.

No real alert delivery is claimed until the manual `test-alert` workflow reports HTTP 2xx from the configured endpoint.
