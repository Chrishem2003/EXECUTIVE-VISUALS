# Google Omni connection gate

Google Omni remains unavailable to cloud workers until an actual Google account/API connection has been completed and verified. This contract is intentionally fail-closed.

## Required provider gates

All four transport/registration switches must be explicitly enabled:

- `GOOGLE_OMNI_VIDEO_ENABLED=true`
- `GOOGLE_OMNI_VIDEO_ALLOW_REMOTE=true`
- `GEMINI_OMNI_ENABLED=true`
- `GEMINI_OMNI_ALLOW_REMOTE=true`

The connection state must also be `GOOGLE_OMNI_CONNECTION_STATUS=connected`. This environment value is only a declaration that a connection was completed; it is not proof on its own.

## Required live verifier

The worker composition must receive `providerDependencies.googleOmniAssertConnection`. It is invoked before input preparation, submission, polling, output ingestion and cost reconciliation.

The callback receives:

```js
{
  provider: "google",
  model: "gemini-omni-1.1-flash",
  job,          // owner/project/job-scoped context, or null
  operation     // prepare | submit | poll | ingest | reconcile_cost
}
```

It must return a verified connection descriptor:

```js
{
  connected: true,
  verified: true,
  connectionId: "opaque-non-secret-connection-reference"
}
```

Any missing, stale, revoked, unverified or mismatched connection must throw or return a non-verified descriptor. The worker then rejects the operation with `GOOGLE_OMNI_CONNECTION_REQUIRED`.

## Connection verifier responsibilities

The application-owned verifier must validate the actual external connection, not merely echo environment flags. It should confirm that:

1. The connected Google account/API credential is present in the approved secret store.
2. The credential is active and authorized for the required Gemini Interactions and Files operations.
3. The connection belongs to the intended application environment and has not been revoked.
4. The request's approval, owner, project and provider policy checks still pass.

Never place Google credentials, OAuth refresh tokens or API keys in source control, job payloads, browser state, or logs.

## Current state

This change wires the live-verification boundary into the provider-aware worker. It does not set any Google environment switches, create a Google connection, call Gemini, or enable paid execution. Google stays gated until the real connection and verifier are supplied and tested.
