# Batch 56 — Agency team seat entitlement enforcement

**Status:** implemented; exact-head CI pending.  
**Scope:** enforce the trusted subscription's account-wide team seat allowance across existing cloud project workspaces.

## Entitlement contract

- The trusted subscription snapshot must contain a positive integer at `limits.teamSeats`.
- The account owner consumes one seat.
- Each distinct collaborator across all projects owned by the account consumes one seat, regardless of whether their role is editor, reviewer or viewer.
- Adding the same collaborator to another project owned by the same account reuses that account seat.
- Removing one project membership frees the seat only when that collaborator has no remaining membership in any other workspace owned by the account.
- A missing, malformed, expired or ambiguous active/trialing subscription fails closed. There is no default or browser-supplied seat limit.

## Enforcement

A database trigger protects every project membership insert/update, including writes that bypass the HTTP endpoint. It locks the single current subscription row before counting unique account members, serializing concurrent seat additions across different projects. The owner-scoped summary RPC returns the plan seat limit, used seats and available seats.

The existing project team API returns this summary alongside the member directory. The workspace shows the capacity and disables adding members when the trusted entitlement cannot be read. When all seats are used, the form remains available so an existing collaborator can be added to another project without consuming a new seat; the database decides whether the account already owns that seat.

## Boundaries

A team seat grants workspace membership only. It does not grant generation permission, bypass the existing editor role, create credits, fund the project wallet or override per-member/project spend caps. The recipient must already have an Executive Visuals account; invitation email delivery is not included.

## Verification and release safety

A disposable PostgreSQL integration covers missing entitlements, owner seat accounting, duplicate collaborators across workspaces, hard limit enforcement, plan allowance increases and seat release after final membership removal. CI applies the additive migration only in its disposable database. No production migration, payment, customer charge, production configuration, merge or deployment is included.
