# C2PA test fixtures

These certificate files are copied from the official Content Authenticity Initiative `c2pa-js` Node SDK test fixtures:

- Upstream: https://github.com/contentauth/c2pa-js/tree/main/packages/c2pa-node/tests/fixtures/certs
- Files: `es256.pem` and `es256.pub`
- Purpose: deterministic integration tests only.

`es256-test-only.private.pem` is a publicly published upstream test key. It is not a production credential, must never be configured for application signing, and must never be reused for real user assets. The matching certificate chain is also an upstream test certificate and is intentionally not trusted by default. The test supplies the upstream signer certificate as an explicit user trust anchor to exercise the SDK's configured-trust result.

Do not copy these files into production images or deployment secrets. They exist only under `server/tests/fixtures/c2pa/`.
