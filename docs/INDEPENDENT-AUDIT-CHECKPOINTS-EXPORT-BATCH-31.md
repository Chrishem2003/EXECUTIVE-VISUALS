# Batch 31 — Independent Audit Checkpoints & Offline Evidence Export

## Scope

Batch 31 adds portable JSON exports of the Batch 30 financial audit ledger, an integrity manifest, optional Ed25519 signatures and an offline verifier. It does not add a paid storage dependency or silently generate signing keys.

## API

\`GET /api/admin/finance/audit/export?ownerId=<uuid>\`

- Requires an authenticated platform owner, platform administrator or billing administrator.
- Reads the selected account's audit chain through the existing server-side service-role API.
- Exports at most 5,000 events per package; the package marks itself incomplete when the stored head exceeds the exported population.
- Includes format/version metadata, owner scope, event envelopes, chain head, verification result, manifest SHA-256 and signature status.

## Signing

Configure \`FINANCIAL_AUDIT_SIGNING_PRIVATE_KEY\` with an Ed25519 PKCS#8 PEM private key to sign the manifest digest. The API derives and includes the matching public key in the export. The private key is never returned to the browser or stored in the audit tables.

Without the environment variable, exports are explicitly marked \`unsigned_key_not_configured\`. Do not treat an unsigned package as signer-authenticated.

The embedded public key only proves that the signature matches that key. For signer identity, the offline verifier must be given an independently trusted public key using \`FINANCIAL_AUDIT_TRUSTED_PUBLIC_KEY\`. Key generation, custody, rotation, revocation and independent checkpoint publication remain operator responsibilities.

## Offline verification

\`\`\`bash
node server/scripts/verify-financial-audit-export.mjs ./executive-visuals-financial-audit.json
\`\`\`

For a trusted signature, provide the public key through \`FINANCIAL_AUDIT_TRUSTED_PUBLIC_KEY\` in the verifier environment. The verifier checks the manifest digest, event chain, event count and head hash, and—when configured—the signature against the trusted public key. It exits non-zero when verification fails or the package is incomplete.

## Integrity limits

- Hash-chain verification detects altered records, sequence gaps, broken predecessor links and a head mismatch.
- A signed manifest authenticates the exported package only when the public key is independently trusted.
- A fully privileged operator could replace the entire source chain before export and produce a new internally consistent bundle. This batch does not publish a checkpoint to independent WORM storage, a timestamp authority or an external witness.
- Exported evidence contains the stored event metadata, not the underlying source files. The export does not validate bank statements, provider invoices, payment receipts or evidence bytes.
- No accounting records, invoices, payments, journals or balances are changed.

## Validation

Unit tests cover unsigned exports, trusted Ed25519 signatures, tampering, key substitution, incomplete exports and input limits. API tests cover administrator authorization and unsigned status. The offline verifier uses the same versioned canonicalization and chain-verification implementation as the online service.
