# Static dotfile exposure policy

The application API denies static requests containing any path segment beginning with a dot. This covers root and nested dotfiles/directories such as environment files, VCS metadata, package-manager configuration, editor metadata and CI configuration.

The guard runs before SPA fallback, so a blocked path returns a generic 404 rather than the application shell. It decodes percent-encoding repeatedly (bounded to three passes), treats malformed encodings and NUL bytes as blocked, and normalizes backslash separators before checking every segment. This prevents common encoded and Windows-separator path variants from bypassing the check.

This is an application-layer defense, not a replacement for deployment controls:
- Do not copy environment files, secrets, private keys, repository metadata or deployment credentials into the public web root or build output.
- Keep secrets in the hosting platform's secret manager and server-only environment.
- Configure the reverse proxy/CDN to deny dot-path requests too, where supported.
- Ensure static asset publication uses an explicit build-output allowlist rather than serving the repository root.
- Review source maps and generated manifests before public release; they are not dotfiles but can still disclose implementation details.
- API routes remain governed by API authentication/authorization and are not made public by the static route.
