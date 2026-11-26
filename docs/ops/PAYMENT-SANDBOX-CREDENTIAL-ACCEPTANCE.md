# Payment provider sandbox credential acceptance

Configure these secrets in the GitHub `staging` environment:
- `PADDLE_SANDBOX_API_KEY`: Paddle sandbox API key only (must contain `_sdbx_`).
- `PESAPAL_SANDBOX_CONSUMER_KEY`: Pesapal sandbox merchant consumer key.
- `PESAPAL_SANDBOX_CONSUMER_SECRET`: Pesapal sandbox merchant consumer secret.

Run the manual `Payment provider sandbox credential acceptance` workflow.

The script makes only two non-payment requests:
- Paddle sandbox GET `/event-types` to verify sandbox authentication.
- Pesapal sandbox POST `/api/Auth/RequestToken` to verify merchant authentication and obtain a short-lived token in memory.

It does not create a checkout, register an IPN, charge a card/mobile wallet, create a subscription, modify provider catalog data, or call a live API. It prints only success indicators and event-type count; never tokens or credentials.

This is a credential smoke test, not full checkout/webhook acceptance. The subsequent acceptance still requires configured provider prices and IPN destination, sandbox purchase success/failure, webhook/IPN signature and transaction verification, duplicates/out-of-order delivery, renewals/cancellations and reconciliation.


## Workflow availability and deployment safety
These workflows currently live on a review branch. GitHub manual `workflow_dispatch` and scheduled `schedule` runs require the workflow file to be present on the repository's default branch. Do not merge this PR to `main` solely to unlock testing: the Executive Visuals Render web service automatically deploys commits to `main`. First establish a safe staging execution path or explicitly approve a controlled deployment/configuration change. Until then, the PR-triggered static checks are the only GitHub Actions evidence; the manual runtime acceptance is pending.
