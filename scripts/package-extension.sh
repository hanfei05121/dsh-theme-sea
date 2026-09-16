#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Git Bash reports /d/... paths that Node cannot resolve on Windows; `pwd -W`
# prints the Windows form and is unavailable (so it falls through) elsewhere.
ROOT_HOST="$(cd "$ROOT" && pwd -W 2>/dev/null || printf '%s' "$ROOT")"
VERSION="$(node -p "require('${ROOT_HOST}/extension/manifest.json').version")"
NAME="open-sea-skin-extension-v${VERSION}.zip"
OUT="${ROOT}/release/${NAME}"

mkdir -p "${ROOT}/release"
rm -f "$OUT"

if ! command -v zip >/dev/null 2>&1; then
  echo "✗ 'zip' was not found." >&2
  echo "  Install it (Debian/Ubuntu: apt-get install zip, macOS: preinstalled)," >&2
  echo "  or load ${ROOT}/extension unpacked as the release artifact." >&2
  exit 1
fi

(
  cd "${ROOT}/extension"
  zip -qr "$OUT" . -x '*.DS_Store' 'README.md'
)
echo "$OUT"
