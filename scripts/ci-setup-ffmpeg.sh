#!/usr/bin/env bash
set -euo pipefail

# Pinned FFmpeg build release and SHA-256 digest.
# Verify upstream fix ancestry and published release checksum before changing these pins.
release_tag="autobuild-2026-11-11-12-39"
asset_name="ffmpeg-N-128790-g9bee1e603c-linux64-gpl.tar.xz"
expected_sha256="f5752bf3597cbc9fc7a60fe5cea3522797a5ea2493d91cffb6f13e5b4c861233"

archive="$RUNNER_TEMP/$asset_name"
extract_dir="$RUNNER_TEMP/ev-ffmpeg"
bin_dir="$RUNNER_TEMP/ev-ffmpeg-bin"
url="https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/$release_tag/$asset_name"
trap 'rm -f "$archive"' EXIT

mkdir -p "$extract_dir" "$bin_dir"
curl --fail --location --show-error \
  --retry 5 --retry-all-errors --retry-delay 2 \
  --connect-timeout 20 --max-time 600 \
  "$url" --output "$archive"

printf '%s  %s\n' "$expected_sha256" "$archive" | sha256sum --check --strict || {
  echo "FFmpeg archive SHA-256 verification failed" >&2
  exit 1
}

tar -xJf "$archive" -C "$extract_dir"
ffmpeg_source="$(find "$extract_dir" -type f -path '*/bin/ffmpeg' -print -quit)"
ffprobe_source="$(find "$extract_dir" -type f -path '*/bin/ffprobe' -print -quit)"
[[ -n "$ffmpeg_source" && -n "$ffprobe_source" ]] || {
  echo "Pinned FFmpeg archive did not contain both ffmpeg and ffprobe binaries" >&2
  exit 1
}

install -m 0755 "$ffmpeg_source" "$bin_dir/ffmpeg"
install -m 0755 "$ffprobe_source" "$bin_dir/ffprobe"
ffmpeg_version="$("$bin_dir/ffmpeg" -version)"
ffprobe_version="$("$bin_dir/ffprobe" -version)"
grep -Fq "N-128790-g9bee1e603c" <<< "$ffmpeg_version"
grep -Fq "N-128790-g9bee1e603c" <<< "$ffprobe_version"
echo "$bin_dir" >> "$GITHUB_PATH"
\n'*}" "${ffprobe_version%%
echo "$bin_dir" >> "$GITHUB_PATH"
\n'*}"
echo "$bin_dir" >> "$GITHUB_PATH"
