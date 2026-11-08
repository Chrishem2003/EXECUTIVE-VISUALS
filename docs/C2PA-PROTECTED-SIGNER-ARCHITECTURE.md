# Protected C2PA signer architecture

**Status:** provider-neutral callback adapter implemented and exercised against the official CAI Node SDK with test-only signing material. No KMS/HSM provider, production key, signing credential, trust anchor or external signing service is configured.

## Design boundary

The application owns provenance policy and transformation orchestration. A protected signer owns private-key operations. The browser, media worker and repository never receive a production private key.

The adapter in `server/c2pa-callback-signer.mjs` creates the official `CallbackSigner` from:
- An allowlisted C2PA signing algorithm.
- A bounded X.509 public certificate chain.
- A bounded signature reservation size.
- An optional HTTPS timestamp authority URL.
- A server-side `sign(data, context)` callback supplied by a provider adapter.

The callback receives the exact signing payload supplied by the CAI SDK and must return the signature bytes expected by that algorithm. Provider-specific adapters must handle their own key identifiers, authorization, digest-mode semantics, signature encoding conversion, network timeouts and error normalization. Do not pre-hash, re-encode or otherwise alter the SDK payload unless the selected KMS/HSM API explicitly requires a documented conversion.

## Intended signing flow

1. The media worker validates source hashes, embedded C2PA manifests and transformation inputs.
2. The application constructs a new manifest and adds each verified credential-bearing source as an ingredient.
3. The callback signer sends only the SDK signing payload to a private backend signer adapter. The adapter authenticates with workload identity or mutually authenticated service credentials and references a non-exportable key by opaque key ID.
4. The KMS/HSM signs under a narrowly scoped signing permission. The private key never leaves the protected key boundary.
5. The callback returns the signature to the CAI SDK.
6. The SDK embeds the manifest into a temporary derivative.
7. The application re-reads and validates the signed derivative, checks all ingredient manifest data, re-hashes sources and output, then atomically publishes the derivative.
8. The application records signer key ID/version, algorithm, certificate fingerprint, request correlation ID, operation, validation result and final output hash in audit metadata. Do not record private material or raw signing payloads.

## Required controls before a real provider adapter

- Non-exportable key in a KMS/HSM with sign-only permissions and no key-management permissions for media workers.
- Workload identity or mTLS; no static provider secret in source code, browser configuration or ordinary job payloads.
- Certificate chain must match the protected key and the selected algorithm; validate key usage/EKU, validity, timestamp and revocation policy.
- Separate signing authority from verification trust anchors. A successful signature is not automatically a trusted identity.
- Provider-specific signature encoding tests using known-answer vectors and the CAI SDK Reader.
- Bounded payload, concurrency, request timeout and cancellation behavior; no unbounded retries after ambiguous provider outcomes.
- Append-only audit evidence for signer identity, key version, operation, request ID, validation outcome and checksum.
- Rotation, revocation, incident response and key-compromise procedures before production approval.
- Independent staging acceptance with a dedicated non-production key and explicit trust policy.

## Fail-closed behavior

If the callback is missing, unavailable, cancelled, returns malformed/oversized signature bytes, or the output fails C2PA validation, the transformation is not published. The temporary output is removed and the original derivative remains unchanged.

## Verification

`npm run verify:provenance` includes a real CAI SDK callback-signing round-trip. The integration uses the repository's documented public test-only fixture key behind a callback to exercise the adapter contract. It does not configure or simulate a production KMS/HSM.

## Release gates

A real KMS/HSM adapter is not complete until its provider-specific integration, authorization boundary, signature encoding, timeout/cancellation, key rotation, audit trail, certificate trust policy and independent staging tests pass. Keep production signing disabled until those gates are reviewed and explicitly approved.
