# Backblaze B2 private media storage

Executive Visuals supports Backblaze B2 as an opt-in S3-compatible object-storage adapter. Supabase Storage remains the default, and Cloudflare R2 remains supported. Selecting B2 does not migrate existing objects automatically.

## Configuration

Set these variables on the **API and every cloud worker that reads or writes the same assets**:

| Variable | Required | Meaning |
|---|---:|---|
| `CLOUD_MEDIA_STORAGE_PROVIDER` | Yes | Set to `b2` to opt in |
| `B2_REGION` | Yes | Bucket region, e.g. `us-west-004` |
| `B2_APPLICATION_KEY_ID` | Yes | ID of a restricted Backblaze application key |
| `B2_APPLICATION_KEY` | Yes | Secret value of that application key |
| `B2_BUCKET` | No | Must remain `executive-visuals-media` |

The S3 endpoint is derived as `https://s3.<B2_REGION>.backblazeb2.com`. Do not set a custom endpoint or expose credentials in browser configuration.

## Backblaze account setup

1. Create the `executive-visuals-media` bucket as **Private** in the intended B2 region.
2. Create a standard application key scoped to that bucket and, where supported by the workload, the Executive Visuals object prefix.
3. Grant only the file-list, read, write and delete capabilities required by the API/worker lifecycle. Never use the account master key.
4. Store the key ID and secret in the hosting provider's encrypted environment-variable store.
5. Deploy first to the isolated cloud-staging service. Do not set the provider on production until the acceptance checks below pass.

## Large-file upload behavior

The B2 adapter automatically uses S3 multipart upload when a file exceeds 100 MiB. It streams 64 MiB parts by default, computes a SHA-256 digest for each part, and retries transient network/server failures up to three attempts per part. The final part may be smaller than 5 MiB; non-final parts must meet B2's 5 MiB minimum. The adapter enforces the 10,000-part maximum, verifies the source file's whole-file SHA-256 before completion, and aborts the multipart upload after permanent part or completion failures.

Smaller files continue to use the existing streamed single-object PUT path. For browser uploads, the opt-in resumable workflow uses durable server-side sessions and short-lived, part-specific SigV4 PUT URLs. The browser uploads parts directly to B2, reports ETag + SHA-256 + byte count, and can retrieve its session state after a refresh. The API reconciles the recorded receipts against B2 List Parts before completion, then independently reads the assembled private object and verifies its whole-file SHA-256, byte count and media type before publishing the Asset Library record. Session metadata never exposes raw provider upload IDs or object paths. Each short-lived presigned part URL necessarily contains the scoped object key and upload ID; treat it as a temporary bearer capability and never log or persist it.

Enable only after the additive multipart ledger migration is applied to the isolated Supabase database and the B2 bucket's S3-compatible CORS rule allows the exact app origin to issue PUT requests and exposes ETag. Keep B2_MULTIPART_UPLOAD_API_ENABLED=false until staging tests cover browser preflight, interrupted upload resume, completion, cancellation, authorization boundaries and object verification. Required API settings are documented in .env.example; the feature is not enabled by default.


## Browser multipart CORS

Direct browser-to-B2 uploads require a bucket CORS rule in addition to the application's own API CORS configuration. For the S3-compatible API, allow the exact deployed web origin, the PUT method, the headers requested by the browser (using * is supported), and expose the ETag response header. Do not enable public bucket access to solve CORS. Keep staging and production origins explicit and separate. See Backblaze's CORS rules guide (https://www.backblaze.com/docs/cloud-storage-cross-origin-resource-sharing-rules) and S3 Put Bucket CORS API (https://www.backblaze.com/apidocs/s3-put-bucket-cors).

## Data and safety contract

- B2 object paths continue to use the existing project/owner UUID, asset UUID and filename layout.
- The bucket is deliberately pinned to `executive-visuals-media`. Asset metadata, publication records and cleanup contracts currently assume that bucket.
- Uploads are size-bounded, content-type allowlisted and streamed with SHA-256 integrity receipts.
- Downloads use short-lived SigV4 pre-signed URLs. Buckets must remain private.
- Worker ingestion validates the configured B2 region, bucket path, media type, byte count and stored asset scope before reading a source.
- Supabase remains the metadata, authorization and audit system. B2 stores object bytes only.
- Changing the storage provider does not copy old files. Existing asset rows must continue resolving against their original storage provider. A production cutover therefore requires a separate migration and dual-read/rollback plan; do not simply flip the environment variable on a populated production environment.

## Acceptance checklist

- [ ] Private bucket exists in the configured region.
- [ ] Restricted application key is configured on staging API and worker only.
- [ ] API readiness confirms `provider=backblaze-b2` and private storage.
- [ ] Upload and streamed upload return the expected size and SHA-256.
- [ ] Signed download succeeds and expires within the requested interval.
- [ ] Cross-project, wrong-bucket and foreign-origin URLs are rejected before fetch.
- [ ] Worker can materialize a source and publish a derivative with matching checksum.
- [ ] Cleanup removes an object idempotently.
- [ ] Application restart does not affect stored media.
- [ ] Cost, storage, API transaction and egress limits are reviewed before enabling customer workloads.

## Cost guardrails

Backblaze publishes the first 10 GB of B2 storage as free and includes free egress up to three times average monthly stored data; additional egress and storage beyond the published free allowance can be charged. Confirm current regional rates before use. Enforce application-level upload quotas, retention limits and per-tenant storage budgets regardless of provider free tiers.

Official references:
- https://www.backblaze.com/cloud-storage/pricing
- https://help.backblaze.com/hc/en-us/articles/360047815993-Does-the-B2-S3-Compatible-API-support-Pre-Signed-URLs
- https://help.backblaze.com/hc/en-us/articles/360052129034-Creating-and-Managing-Application-Keys
