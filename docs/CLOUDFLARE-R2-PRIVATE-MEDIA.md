# Cloudflare R2 private media storage

This repository includes an optional S3-compatible Cloudflare R2 adapter. It is disabled by default; existing Supabase Storage remains the default until an operator explicitly selects R2 and provisions the bucket and credentials.

## Adapter

- Module: `server/cloudflare-r2-storage.mjs`
- Provider selector: `CLOUD_MEDIA_STORAGE_PROVIDER=r2`
- Bucket: `R2_BUCKET=executive-visuals-media`
- Credentials: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
- Endpoint: `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`

The adapter uses AWS Signature Version 4 with the R2 `auto` region and S3 service scope. It supports private PUT uploads, bounded streaming file uploads with SHA-256 receipts, short-lived presigned GET URLs, exact-object deletion and a signed bucket readiness probe. No AWS SDK dependency or credential is committed.

## Enablement checklist

1. Create the private `executive-visuals-media` bucket in the existing Cloudflare account only after confirming billing and the free-tier allowance.
2. Create an R2 S3 API token scoped to that bucket with Object Read and Object Write permissions. Keep the access key and secret in the backend host's protected environment variables.
3. Set `CLOUD_MEDIA_STORAGE_PROVIDER=r2`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` on the backend service. Do not set these in Vite or expose them to the browser.
4. Configure bucket CORS for the exact application origin. Permit GET and HEAD, allow the required Range request header, and expose Content-Length, Content-Type, ETag, Accept-Ranges and Content-Range.
5. Confirm the Supabase `executive_visuals` metadata schema and required tables/RPCs are installed in a dedicated, isolated project before enabling the cloud timeline API. R2 stores media bytes; it does not replace the application metadata database, auth, job queue or worker.
6. Restart staging first. Verify the R2 bucket readiness probe, authenticated owner/project authorization, upload checksum, signed download, deletion and cleanup-outbox recovery before production enablement.

## Cost and deployment boundary

Cloudflare's published R2 Standard free tier currently includes 10 GB-month storage, 1 million Class A requests and 10 million Class B requests per month. Usage above the allowance is billable; configure account spending controls and monitor usage. R2 egress is free. This adapter does not create a bucket, create credentials, change billing, or enable itself automatically.

The existing Render Free service has an ephemeral filesystem and spins down when idle. R2 media storage alone does not make its SQLite metadata database durable. A separately verified persistent database is still required before production readiness can pass.
