# Payment provider sandbox credential acceptance

Configure these secrets in the GitHub `staging` environment:
- `PADDLE_SANDBOX_API_KEY`: Paddle sandbox API key only (must contain `_sdbx_` and must not contain `_live_`).
- `PESAPAL_SANDBOX_CONSUMER_KEY`: Pesapal sandbox merchant consumer key.
- `PESAPAL_SANDBOX_CONSUMER_SECRET`: Pesapal sandbox merchant consumer secret.

Run the manual `Payment provider sandbox credential acceptance` workflow.

## Safety and response handling

The verifier makes only two non-payment requests:
- Paddle sandbox GET `/event-types` to verify sandbox authentication.
- Pesapal sandbox POST `/api/Auth/RequestToken` to verify merchant authentication and obtain a short-lived token in memory.

It uses fixed sandbox hosts, rejects redirects, applies a 15-second timeout, bounds provider responses to 1 MiB and never logs response bodies, credentials or access tokens. It does not accept a configurable API base URL, so a live host cannot be selected through workflow inputs.

It does not create a checkout, register an IPN, charge a card/mobile wallet, create a subscription, modify provider catalog data, or call a live API. It prints only success indicators and event-type count.

CI tests use synthetic credentials and mocked HTTP responses; they do not contact either provider.

## Remaining acceptance

This is a credential smoke test, not full checkout/webhook acceptance. Subsequent acceptance still requires configured provider prices and IPN destination, sandbox purchase success/failure, webhook/IPN signature and transaction verification, duplicate/out-of-order delivery, renewals/cancellations and reconciliation.

## Workflow availability and deployment safety

GitHub manual `workflow_dispatch` requires the workflow file to exist on the repository default branch. Do not merge this PR to `main` solely to unlock testing: Render web services are configured to auto-deploy commits to `main`. Keep the workflow in review until a safe staging execution path is approved. The PR-triggered static checks are the only evidence until the staging workflow is intentionally made available and run.
