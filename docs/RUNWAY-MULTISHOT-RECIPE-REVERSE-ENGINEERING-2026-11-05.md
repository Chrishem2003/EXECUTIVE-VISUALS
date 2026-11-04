# Runway Multi-Shot Video Recipe — reverse-engineered contract

Research snapshot: 2026-11-05. This branch adds a local request planner and estimate-only pricing contract. It does not call Runway or start a paid task.

## Why this integration matters

Executive Visuals already has projects, briefs, scripts, shot lists and timeline workspaces. Runway's Multi-Shot Video Recipe is a direct match for one of those existing workflows:

- Auto mode accepts one story prompt and decomposes it into five shots.
- Custom mode accepts three to five ordered shots with per-shot durations.
- The custom shot durations must sum exactly to the requested total.
- Supported total durations are 5, 10 or 15 seconds.
- A first-frame image is optional.
- A dated workflow version can be pinned to avoid silently following changing behavior.

## Pricing snapshot

The published pricing guide lists:
- 720p: 13 credits per second.
- 1080p: 17 credits per second.
- Minimum/maximum duration: 5–15 seconds.

The planner maps the documented ratio tiers to 720p or 1080p and returns an estimate. It does not reserve credits or treat the estimate as a bill.

Official sources:
- https://docs.dev.runwayml.com/recipes/multi-shot-video/
- https://docs.dev.runwayml.com/guides/pricing/
- https://docs.dev.runwayml.com/api/

## Implemented

- `server/runway-multishot-recipe.mjs`
  - Validates auto/custom modes, pinned recipe version, duration, ratio, audio flag, prompt length and shot count.
  - Enforces 3–5 custom shots and exact duration sum.
  - Resolves optional first-frame image from a private asset ID using authenticated project context and the private asset resolver.
  - Produces a separate, dated pricing estimate.
- `server/tests/runway-multishot-recipe.test.mjs`
  - Covers valid auto/custom payloads, duration arithmetic, pricing tier selection, invalid inputs and private asset authorization.
- `package.json`
  - Adds the recipe tests to `verify:video-routing`.

## Integration boundary

This is not yet a live recipe adapter. A production adapter must use the durable cloud submission ledger, one-shot POST protection, explicit user approval, budget reservation, actual task cost evidence, polling, private output ingestion and output validation. Do not expose Runway's temporary output URLs directly to users.

## Product architecture recommendation

Expose Multi-Shot Video as an optional backend for Executive Visuals' existing shot-list workflow, not as a replacement for its own timeline and production engine. Keep the user's editable shot list and approved script as the source of truth. Use Runway to generate the multi-cut source asset, then ingest it into the existing timeline for review, finishing, captions, audio and export.
