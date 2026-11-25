# Batch 112 — unknown provider billing metrics remain unknown

## Problem

Batch 107 allowed an outcome of unknown and a null actual cost, but its usage
columns were NOT NULL. An adapter therefore had to send zero billable seconds,
zero references and a boolean audio value even when the provider had not reported
those facts. Zero is a real measurement; it must not stand in for missing evidence.

## Delivered

- Allow billable seconds, input-reference count and audio mode to be null only for
  unknown provider outcomes.
- Keep all three usage metrics mandatory for charged and no-charge outcomes.
- Keep the no-charge rule strict: actual provider cost must be zero and billable
  seconds must be zero.
- Keep charged outcomes strict: actual cost must be positive and usage metrics
  must be present.
- Keep unknown actual cost and cost variance null.
- Update the HMAC verifier and server ingestion tests to preserve explicit nulls.
- Update the PostgreSQL integration test to prove that unknown usage fields persist
  as null without changing or releasing customer credits.
- Apply the additive migration after Batch 107 and before the provider evidence
  integration test in CI.

## Compatibility

Existing evidence rows are not rewritten. Existing unknown rows with zero-valued
metrics remain as historical observations; new evidence can accurately represent
unavailable metrics as null. Charged and no-charge evidence continues to require
complete usage metrics.

## Safety

This is an evidence-quality migration only. It does not settle credits, release
reservations, call providers, activate payments, or touch production.
