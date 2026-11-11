#!/usr/bin/env bash
set -euo pipefail

# Pinned FFmpeg build release and SHA-256 digest.
# Update both values together after reviewing a new upstream release.
release_tag="autobuild-2026-11-09-12-42"
asset_name="ffmpeg-n9.0.2-48-gd4070a14ce-linux64-gpl-9.0.tar.xz"
expected_sha256="5df8a8fd95464cd5ff7b7abff4afe59dede6fa7af13e0914a0abc70178d87046"

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
echo "$bin_dir" >> "$GITHUB_PATH"
