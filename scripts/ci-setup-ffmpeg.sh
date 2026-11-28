#!/usr/bin/env bash
set -euo pipefail

# Pinned FFmpeg build release and SHA-256 digest.
# Verify upstream fix ancestry and published release checksum before changing these pins.
release_tag="autobuild-2026-11-26-12-56"
asset_name="ffmpeg-N-129308-g17de9f8597-linux64-gpl.tar.xz"
expected_sha256="1626509a8649d8d392ecddd9969c087e9f50df7a75f8164b5b0b4eee55a59428"

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
grep -Fq "N-129308-g17de9f8597" <<< "$ffmpeg_version"
grep -Fq "N-129308-g17de9f8597" <<< "$ffprobe_version"
echo "$bin_dir" >> "$GITHUB_PATH"
