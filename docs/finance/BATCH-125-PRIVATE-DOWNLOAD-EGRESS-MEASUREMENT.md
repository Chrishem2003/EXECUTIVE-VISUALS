# Batch 125 — Private-download egress stream measurement

## Purpose

Establish a byte-evidence primitive for private asset downloads. A signed URL is only authorization to attempt a transfer; it is not evidence of egress and must never create a cost event.

## What this batch adds

- `server/asset-egress-stream.mjs` streams a successful private-object response to the outgoing Node HTTP response.
- It supports both full-object (200) and partial/range (206) responses.
- It copies only safe response metadata and rejects a transfer that would exceed the persisted asset size.
- It increments the measured byte count only after the outgoing response write callback succeeds. If a client disconnects, already-accepted chunks are measured and the transfer is marked partial.
- It emits the existing recorder measurement contract: `completed_private_asset_http_response`, `egress_gb`, decimal GB, persisted asset attribution, transfer identity and timestamp.
- A fresh transfer ID distinguishes separately attempted transfers; recorder idempotency protects retries of the same measurement identity.
- The asset metering CI workflow runs the stream acceptance tests.

## Measurement semantics and limits

Node's outgoing response callback is the strongest server-side delivery evidence available in this HTTP path, but it is not an end-client receipt or proof that a browser saved the complete file. The event records bytes accepted by the server's response stream, not declared Content-Length, requested range length, signed URL issuance, or bytes merely read from storage.

Zero-byte transfers create no event. Upstream errors outside 200/206 create no event. Partial transfers record only chunks whose write callbacks succeeded. A later retry is a separate transfer and is measured separately if bytes are accepted.

## Deliberately not claimed as complete

This batch adds and tests the streaming measurement primitive; it does **not yet replace** `GET /api/cloud/assets/:id` signed-URL delivery with a server-side streaming route, nor does it wire the recorder into the authenticated HTTP handler. That integration is the next step and must be completed before any production egress accounting is enabled.

The existing database RPC requires a configured financial-system/platform-admin actor. The application must not weaken that boundary or accept an actor ID from the customer request. The next integration must inject a trusted server-side recorder and fail closed if it is unavailable; it must not report a successful metering state when evidence could not be persisted.

## Safety

- No signed-URL request is counted as egress.
- No customer wallet, subscription balance, or charge is modified.
- No provider generation or paid infrastructure is invoked.
- No production migration, deployment, or merge is performed.
