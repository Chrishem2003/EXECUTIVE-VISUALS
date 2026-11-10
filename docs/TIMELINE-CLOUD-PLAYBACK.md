# Private cloud timeline playback

## What this batch enables

The timeline program monitor can load private cloud project media as well as local media. It uses the existing authenticated cloud asset endpoint to mint a time-limited signed URL; the browser then loads that URL directly into native video, audio and image elements. The signed URL is not stored in the timeline document.

The server only issues a signed URL after the cloud asset repository verifies the authenticated user against the asset's owner/project boundary. The cloud storage adapter also checks that the object path belongs to the expected private bucket and project or owner prefix.

## Content security policy

The application derives the allowed media and image origin from the configured HTTPS Supabase URL. This keeps remote media loads constrained to the configured storage origin instead of permitting arbitrary external media hosts.

## Proxy selection and fallback

A clip's \`metadata.proxyAssetId\` is treated as a preference, not as authority. The preview selector only uses a candidate that:
- appears in the current authenticated asset collection;
- is a video asset; and
- declares \`derivativeOf\` equal to the clip's canonical source asset ID.

If the proxy cannot be signed, the preview falls back to the original source. If the browser later reports a proxy media error, the preview marks that proxy unavailable for the session and loads the original source instead. The canonical \`clip.assetId\` is never changed; master renders continue using the original source.

Cloud proxy generation and source-frame extraction are not included because the cloud media worker does not yet expose those job types. This batch reuses existing linked derivatives only.

## Playback diagnostics

The program monitor reports:
- unique media sources loaded and proxy selections;
- proxy-to-original fallbacks;
- browser-reported dropped and total video frames when supported;
- media waiting events; and
- media/image load errors.

These are browser-side diagnostics, not a substitute for measured render-worker telemetry or a guarantee of real-time performance.

## Security and limits

- Signed cloud media URLs are cached only until they enter a 30-second renewal window; the client requests a fresh URL before expiry rather than treating a stale URL as valid for the lifetime of the editing session.
- Local blob previews remain cached until the preview session is released.
- The client validates HTTPS, the signed-storage path shape, asset identity and the returned expiry bound before using a URL.
- CSP only permits media and image requests to the configured Supabase origin.
- No service-role key is sent to the browser.
- No public bucket, database migration, paid storage, production deployment or cloud-worker mutation is part of this batch.
