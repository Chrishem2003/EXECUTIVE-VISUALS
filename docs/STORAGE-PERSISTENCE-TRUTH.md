# Storage persistence status and deployment truth

The API health response reports a persistence classification so the UI does not imply that every reachable API has durable storage.

## Classifications

- `ephemeral`: the configured data directory is `/tmp` or a child of it. Data may disappear when the process or instance is replaced.
- `unverified`: the data directory is outside `/tmp`, but the application has no evidence that the host attached a persistent volume. A non-temporary path is not proof of durability.
- `operator-confirmed-volume`: the operator explicitly sets `DATA_DIR_PERSISTENCE=persistent-volume` after attaching and verifying the host volume. This is an operator assertion, not an automated mount or backup test.

The health endpoint exposes only the classification and whether `REQUIRE_PERSISTENT_DATA_DIR` startup checks are enabled. It does not expose absolute filesystem paths or credentials.

## Deployment configuration

1. Configure `DATA_DIR`, `DB_FILE`, and `MEDIA_ROOT` beneath the intended mounted volume.
2. Attach the persistent disk/volume in the hosting provider and verify that it is mounted at the configured path.
3. Set `REQUIRE_PERSISTENT_DATA_DIR=true` to make startup fail when the configured data path is missing or the database/media paths escape it.
4. Only after verifying the mount, set `DATA_DIR_PERSISTENCE=persistent-volume` so the UI can describe the volume as operator-confirmed.
5. Test backup, restore, restart, redeploy and instance-replacement behavior separately. The classification does not certify those operations.

For a disposable preview, leave `DATA_DIR_PERSISTENCE` unset. If `DATA_DIR` is under `/tmp`, the API reports `ephemeral`; otherwise it reports `unverified`.

## Release policy

- Do not treat `unverified` or `ephemeral` storage as durable customer storage.
- Do not enable paid provider workflows merely because the health endpoint returns `status: ok`.
- Production readiness still requires isolated staging, tested backups/restores, private object storage, authorization checks and operational recovery evidence.
