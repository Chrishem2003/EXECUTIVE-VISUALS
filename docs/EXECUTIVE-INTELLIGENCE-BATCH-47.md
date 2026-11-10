# Batch 47 — Executive Intelligence

## Purpose

Provide a boardroom-oriented, evidence-linked executive brief inside the existing Financial Command Centre. The brief is assembled from the authenticated finance-admin workspace's currently loaded source domains.

## Included

- Executive KPI strip showing currency-group count, loaded source-domain coverage, recorded liquidity alerts, margin alerts, dispute cases and saved scenario snapshots.
- Rule-based management-attention items tied to available alert/register counts.
- Explicit unavailable-source states; missing records are not silently converted to zero.
- Currency-separated command-centre evidence, source coverage inventory and report-generation timestamp.
- JSON export for portable evidence review.
- Print stylesheet for browser Print / Save as PDF.
- Responsive Aurora styling consistent with the existing purple financial workspace.
- Draft/review status and explicit non-audit / non-approval limitations.

## Source domains

The report inventories the command-centre response, cash-flow forecast, profitability, customer lifetime/acquisition economics, liquidity alerts, margin alerts, dispute register, immutable scenario snapshots, audit integrity verification and financial close workflow.

The brief only uses data already loaded by the existing protected APIs. It does not independently re-fetch or certify the underlying transactions, infer missing accounting values, combine currencies, or claim that an unavailable alert source means no risk exists.

## Interpretation and governance

- Alert counts are triage indicators, not measures of financial exposure or severity.
- The report does not infer root causes from counts.
- Currency evidence is preserved as separate source rows; no foreign-exchange conversion is performed.
- Source-domain availability is not the same as source completeness or independent assurance.
- The output is a session-generated draft. It is not persisted as an immutable report record and does not create a formal approval or audit event.
- Before circulation, finance leadership must verify source documents, reporting cut-offs, accounting policies, materiality, reconciliations and sign-off authority.

## Verification

`npm run verify:financial-executive-intelligence` runs the Batch 47 report contract checks. The billing CI workflow also runs these checks on the Batch 47 branch. A passing static contract test does not replace browser QA, data-quality review, or staging verification.

## Safety

No journal entries, payments, transfers, pricing changes, accounting approvals, production migrations or production deployments are performed by this feature.
