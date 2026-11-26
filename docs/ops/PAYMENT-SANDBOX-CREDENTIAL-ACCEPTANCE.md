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
The manual `workflow_dispatch` trigger requires the workflow file on the default branch. The protected runtime acceptance job also runs on same-repository PRs authored by `Chrishem2003`, using only the GitHub `staging` environment and its secrets; fork PRs cannot access those secrets. This permits staging acceptance without merging to `main`. If required staging secrets or test identities are absent, the runtime job fails with a clear configuration error. Do not merge solely to unlock manual dispatch because Render automatically deploys commits to `main`.
