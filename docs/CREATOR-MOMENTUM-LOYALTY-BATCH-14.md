# Batch 14 — Creator Momentum loyalty and retention

## Customer promise

The first verified paid subscription unlocks a one-time Creator Momentum welcome reward:

- 30 additional days on the exact plan the customer purchased.
- 100 bonus creator credits.
- The additional access is appended to the paid period, so it does not require a second checkout.
- No automatic renewal is created by the reward. Existing subscription renewal rules remain unchanged.
- The reward is displayed in Billing & Subscription with its actual extended period end and credit ledger balance.

The campaign is configurable in the database and has a status, start/end dates, reward limits, award cap and counters. Defaults are seeded as an active campaign; operators can pause or end it through a future protected campaign-administration workflow.

## Implementation

- PostgreSQL campaign, reward and loyalty-event tables.
- Transactional trigger on the pending-to-active transition of a verified Flutterwave subscription.
- Eligibility checks require the matching successful subscription-purchase payment and no earlier successful subscription purchase for that customer.
- Unique owner/reward and payment/campaign constraints prevent duplicate grants.
- The paid period is extended by the configured number of days.
- Bonus credits are recorded in the existing credit ledger using a reward-specific idempotency key.
- A notification-outbox event is queued for the customer.
- A customer-scoped RPC returns reward history, events and credit balance.
- Billing API and workspace display the welcome reward and explain the terms.

## Safety and commercial integrity

- The reward is issued only after server-side provider verification, never on checkout creation or browser return.
- A retry of the verified payment finalizer does not re-award the reward.
- One reward per customer account for the first paid subscription campaign.
- The offer is explicit: extra access time and bonus credits; no hidden charge or auto-renewal is attached to the reward.
- No payment method is stored or charged automatically.
- No production migration, live payment, deployment or merge is part of this batch.

## Validation

Disposable PostgreSQL integration asserts the first-purchase extension, exactly-once reward record and credit ledger grant. The billing API test verifies customer scoping and reward summary output. The CI workflow applies the new migration after subscription lifecycle migrations.

## Next growth work

Batch 15 should add referral attribution with anti-self-referral controls, creator milestone rewards, renewal streaks, cancellation save offers that are optional and clearly disclosed, and cohort analytics measuring trial-to-paid conversion, first renewal, 90-day retention and reward cost.
