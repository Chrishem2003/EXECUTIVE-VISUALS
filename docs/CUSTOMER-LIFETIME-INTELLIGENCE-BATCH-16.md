# Batch 16 — Customer Lifetime Intelligence

## Customer-facing creator journey

The Billing workspace now includes a private milestone panel. It shows completed achievements, points, overall milestone progress and the next incomplete achievement.

Milestones:
- First project created — 10 points
- First render completed — 25 points
- First asset uploaded — 10 points
- First workflow completed — 25 points
- Five authenticated creative sessions — 15 points
- Creative activity on seven distinct days within a rolling 14-day window — 30 points

Milestones are one-time achievements, not financial credits or subscription entitlements.

## Product activity signals

The client records an allowlisted event after authenticated sessions and selected product actions:
- session_started
- workspace_opened
- project_created
- render_completed
- asset_uploaded
- workflow_completed
- tutorial_completed
- billing_viewed

Event records intentionally exclude prompt text, uploaded filenames, media, project descriptions, creative content, payment credentials and private asset paths. The API derives the owner ID from the authenticated session. Event keys are bounded and unique per owner, so refreshes and retries do not inflate activity.

## Explainable customer health score

The score is a 0–100 prioritization aid, not a decision engine.

Components:
- Activity recency: up to 30 points
- Activity-event frequency in the last seven days: up to 25 points
- Recent projects, renders and completed workflows: up to 20 points
- Earned product milestones: up to 15 points
- Current subscription state: up to 10 points

Risk bands:
- Healthy: 75–100
- Watch: 50–74
- At risk: 25–49
- Critical: 0–24

Recommended human-review actions include onboarding help, first-value nudge, usage guidance, renewal check-in, payment recovery and win-back. No automated outreach, charges, refunds, cancellation, entitlement change, account restriction or fraud decision is triggered.

## Admin surface

The protected Financial Command Centre includes:
- Customer population and average health
- Healthy, watch, at-risk and critical counts
- Up to 100 lowest-scoring customer profiles
- Last activity, recent project/render activity and recommended intervention type

Access is limited to platform owner, platform admin and billing admin roles. Customer milestone summaries are owner-scoped. Customer-success tables are service-role-only.

## Validation

The PostgreSQL integration workflow verifies:
- Five-session and first-project/render/asset/workflow milestone awards
- Correct achievement count and points
- Health score reflects recent verified product activity
- Duplicate event keys do not create duplicate activity or awards

API tests verify event allowlisting, customer scoping and admin authorization.

## Known next steps

- Cohort retention curves by first paid subscription month and plan interval
- Renewal-window reminders and opt-in customer-success outreach
- Intervention outcomes and incremental retention measurement
- Experiment framework for onboarding and first-value improvements
- Reconcile usage telemetry with the durable cloud project/job event stream
