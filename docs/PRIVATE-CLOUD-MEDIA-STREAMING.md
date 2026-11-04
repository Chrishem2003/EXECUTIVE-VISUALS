# Private cloud media streaming

**Milestone:** E1 — authenticated browser playback for cloud project assets  
**Implementation branch:** `feat/private-cloud-media-streaming`  
**Status:** implementation and automated verification in progress.

## Request path

The browser requests a same-origin URL:

`GET /api/cloud/assets/:assetId/content`

The request passes through the normal application authentication middleware. The server uses the verified account ID to ask the cloud asset repository for a short-lived Supabase signed URL. It then fetches the object server-side and streams the response back to the browser.

The signed storage URL and service-role credentials are never returned to the browser. Video/audio range requests are forwarded to Supabase and the server validates the returned `Content-Range` against the asset's stored size.

## Security controls

- Authentication is required before the streaming route is reached.
- The repository re-checks owner/project read access before creating a signed URL.
- Only the configured Supabase origin is accepted for the upstream signed URL.
- Redirects are rejected; credentials and signed URLs remain server-side.
- Only one valid byte range is accepted per request; malformed multi-range input is rejected.
- The upstream response is streamed rather than buffered in application memory.
- A request timeout remains active for the lifetime of the body stream.
- Client disconnects abort the upstream fetch and release the stream.
- Responses use `private, no-store`, `nosniff`, and an inline disposition.
- The media bucket remains private; no public bucket or permanent public URL is introduced.

## Browser integration

The timeline editor now resolves local and cloud media through one source helper. Local assets use the existing local file route; cloud assets use the authenticated same-origin streaming route. The same boundary is used by the sequence monitor, audio tracks, still-image overlays, captions and selected-source monitor.

## Acceptance still required

- Hosted acceptance with a dedicated Supabase project and private media bucket.
- Test project owner, editor and reviewer access boundaries with actual user sessions.
- Verify byte-range playback and seeking in supported browsers with real MP4/WebM/audio fixtures.
- Confirm private media remains inaccessible after logout, project membership revocation and asset deletion.
- Compare preview output against the FFmpeg master renderer.

No production deployment, database migration, public bucket change or paid provider activation is included.
