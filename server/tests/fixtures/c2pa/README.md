These certificate and private-key fixtures are copied from the official Content Authenticity Initiative `contentauth/c2pa-js` repository at `packages/c2pa-node/tests/fixtures/certs/es256.pub` and `es256.pem`.

They are intentionally public, test-only signing material. They must never be used to sign customer, production, staging or release assets. The integration test generates a fresh in-memory PNG, signs it with this upstream test key using the official CAI SDK, then reads and validates the embedded manifest with the SDK Reader.
