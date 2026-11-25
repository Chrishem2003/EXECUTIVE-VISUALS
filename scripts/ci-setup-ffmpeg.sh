#!/usr/bin/env bash
set -euo pipefail

# Immutable upstream release tag plus the release-published SHA-256 manifest.
# Change the tag/version only after checking the upstream release and its manifest.
release_tag="autobuild-2026-11-24-12-41"
asset_name="ffmpeg-N-129267-g9ec5cf1aac-linux64-gpl.tar.xz"
checksums_name="checksums.sha256"
expected_version="N-129267-g9ec5cf1aac"

archive="$RUNNER_TEMP/$asset_name"
checksums="$RUNNER_TEMP/$checksums_name"
extract_dir="$RUNNER_TEMP/ev-ffmpeg"
bin_dir="$RUNNER_TEMP/ev-ffmpeg-bin"
base_url="https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/$release_tag"
checksums_url="$base_url/$checksums_name"
url="$base_url/$asset_name"
trap 'rm -f "$archive" "$checksums"' EXIT

mkdir -p "$extract_dir" "$bin_dir"
curl --fail --location --show-error \
  --retry 5 --retry-all-errors --retry-delay 2 \
  --connect-timeout 20 --max-time 120 \
  "$checksums_url" --output "$checksums"

expected_sha256="$(awk -v asset="$asset_name" '$2 == asset { print $1 }' "$checksums")"
[[ "$expected_sha256" =~ ^[a-f0-9]{64}$ ]] || {
  echo "Pinned FFmpeg release checksum manifest did not contain one valid checksum for $asset_name" >&2
  exit 1
}

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
grep -Fq "$expected_version" <<< "$ffmpeg_version"
grep -Fq "$expected_version" <<< "$ffprobe_version"
echo "$bin_dir" >> "$GITHUB_PATH"
