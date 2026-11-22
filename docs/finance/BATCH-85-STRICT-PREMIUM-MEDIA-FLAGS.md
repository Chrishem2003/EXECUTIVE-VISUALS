# Batch 85 — Strict premium media flags in subscription economics

**Status:** draft implementation stacked on Batch 84 (#819).  
**Purpose:** prevent malformed client values from silently disabling provider-cost options.

## Change

The subscription plan economics API accepts optional `audio` and `hdr` scenario flags. Previously, it converted values using strict equality with `true`. A malformed value such as `"true"`, `1`, or `"false"` could therefore be treated as `false` and silently omit an audio or HDR charge.

The API now accepts only actual JSON booleans when either field is supplied. Missing fields retain the existing default-off behavior. Invalid types fail with `SUBSCRIPTION_ECONOMICS_MEDIA_FLAG_INVALID` before a scenario can be priced.

## Regression coverage

- HDR string `"true"` rejected.
- HDR numeric `1` and `0` rejected.
- Audio string `"false"` rejected.
- Existing boolean HDR path remains covered by Batch 84's governed 1080p HDR pricing test.
- Existing missing HDR surcharge test continues to fail closed.

## Boundaries

This is a forecast validation change only. No provider calls, customer credit reservations, ledger changes, public plan activation, payment processing, production migration or deployment occur. The billing workflow is extended to run on this branch.
