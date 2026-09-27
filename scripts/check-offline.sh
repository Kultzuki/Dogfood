#!/bin/sh
# check-offline.sh — CI guard: fail if templates/, static/, or shipped src/
# contain references to external CDNs, webfonts, or remote URLs.
#
# Allowed: https://opencode.ai in comments only (schema reference).
# Allowed: *.test.ts fixtures (webhook SSRF-guard tests use example URLs;
#   test files never execute in the browser and perform no network I/O
#   beyond local resolver calls).
# Policy: the platform must start and render with network disabled.

set -eu

EXIT_CODE=0

# Grep for forbidden patterns; --exclude-dir=node_modules avoids noise.
# The pattern intentionally matches "http://" and "https://" literally.
# Files containing "opencode.ai" as a schema reference comment are excluded
# by a post-grep filter.
for DIR in templates static src; do
  if [ -d "$DIR" ]; then
    MATCHES=$(grep -rEi 'cdn|googleapis|gstatic|unpkg|http://|https://' "$DIR" \
      --exclude-dir=node_modules \
      --exclude='*.md' \
      --exclude='*.lock' \
      --exclude='*.svg' \
      --exclude='*.test.ts' \
      2>/dev/null || true)

    if [ -n "$MATCHES" ]; then
      # Filter out the known-allowed schema comment line
      CLEAN=$(echo "$MATCHES" | grep -v 'opencode.ai' || true)
      if [ -n "$CLEAN" ]; then
        echo "::error::Offline policy violation in $DIR:"
        echo "$CLEAN"
        EXIT_CODE=1
      fi
    fi
  fi
done

if [ "$EXIT_CODE" -ne 0 ]; then
  echo ""
  echo "FAILED: External URL references detected. All assets must be self-hosted."
  exit 1
fi

echo "OFFLINE-CLEAN: No external URL references found."
exit 0
