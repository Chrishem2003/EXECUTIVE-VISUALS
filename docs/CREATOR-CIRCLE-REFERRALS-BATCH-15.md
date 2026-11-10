# Batch 15 — Creator Circle referrals

## Customer proposition

Creator Circle makes Executive Visuals more rewarding to share:

- Each customer receives a unique invite code.
- A new creator may attribute one invite code before their first paid subscription.
- After the referred creator completes a first provider-verified subscription payment, both the referrer and the new creator receive 50 bonus creator credits.
- Rewards are ledger-backed and idempotent; pending sign-ups do not earn rewards.

## Abuse and integrity controls

- Self-referrals are rejected.
- One referral attribution per referred account.
- Attribution is rejected after the referred account has already completed a successful subscription purchase.
- The code must be active and belong to a valid account.
- Rewards are only granted after the verified subscription activation transition.
- Unique referral reward and credit-ledger idempotency constraints prevent duplicate awards.
- The campaign has active/paused/ended state, start/end dates, per-side credit amount and a maximum conversion cap.
- No cash payout, payment discount, stored credential or automatic charge is involved.

## Product surface

- Billing workspace shows the customer's invite code, conversion count and earned referral credits.
- Customers can copy their code and apply another creator's code.
- The UI explains the exact qualification event and one-referrer rule.
- Referral attribution and summary APIs use the authenticated account identity; clients cannot select the referrer identity.

## Validation

The disposable PostgreSQL integration script creates two users, verifies code generation, rejects self-referral, attributes the second user, finalizes a verified first payment and asserts both rewards plus conversion status. API tests cover owner scoping and malformed-code rejection.

## Follow-up growth work

Next: referral cohort analytics, invite funnel attribution, renewal streak milestones, optional cancellation alternatives, personalized onboarding and a retention command centre measuring activation, first renewal, 90-day retention, referral conversion and reward cost.
