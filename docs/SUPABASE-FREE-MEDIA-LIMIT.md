# Supabase Free media upload limit

The current staging organization is on the Supabase Free plan. Supabase documents a 50 MB global maximum individual file size for Free projects. The private Executive Visuals bucket previously advertised 250 MiB, and the application upload queue and API also allowed 250 MiB. That mismatch caused users to select files the backing plan could not reliably accept.

## Enforced behavior

- Supabase-backed cloud uploads are capped at **50 MiB per file** in the server, browser preflight and private bucket.
- An explicit `CLOUD_MEDIA_MAX_UPLOAD_BYTES` setting cannot raise the Supabase-backed cap above 50 MiB.
- Other configured storage providers retain their independently configured limit.
- The local-disk upload limit is unchanged.
- Existing objects are not deleted, rewritten or resized by this migration.
- The cap is per object, not the total storage quota. The separate database quota remains 750 MiB global / 512 MiB per owner.

## Large-footage path

Supabase recommends TUS resumable uploads for files above 6 MB or unstable networks, but the Free plan's 50 MB object ceiling still applies. R2 multipart uploads can support much larger objects, but the R2 integration remains disabled until its bucket, credentials and cost/usage controls are explicitly configured. Do not raise the Supabase cap to simulate R2 support.

References:
- Supabase file upload limits: https://supabase.com/docs/guides/storage/uploads/file-limits
- Supabase resumable uploads: https://supabase.com/docs/guides/storage/uploads/resumable-uploads
- Cloudflare R2 multipart uploads: https://developers.cloudflare.com/r2/objects/upload-objects/
