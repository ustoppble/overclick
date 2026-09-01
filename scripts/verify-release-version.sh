#!/usr/bin/env bash
# The release-tag guard (OCL-73): a `vX.Y.Z` tag must always land on the exact
# commit whose manifests already carry that version. When the two drift,
# `apps/web/src/lib/updates.ts` reads a stale APP_VERSION baked from the
# unbumped manifest, so an instance that already runs the tagged content still
# gets told it is out of date — the false-positive banner this script exists
# to make impossible again.
#
# OCL-158: the list of manifests lives in scripts/release-manifests.mjs, the
# same list scripts/release.sh bumps. This script used to carry its own copy
# with four of the eleven entries, so a bump that missed the seven plugin
# manifests passed the guard and shipped.
#
# Usage: scripts/verify-release-version.sh [tag]
# Without an argument, reads the tag off GITHUB_REF_NAME (set by the
# release-image workflow on every `v*` tag push).
set -euo pipefail

cd "$(dirname "$0")/.."

TAG="${1:-${GITHUB_REF_NAME:-}}"
if [ -z "$TAG" ]; then
  echo "!! no tag given and GITHUB_REF_NAME is unset" >&2
  exit 1
fi

TAG_VERSION="${TAG#v}"

fail=0
count=0
while IFS=$'\t' read -r manifest version; do
  [ -z "$manifest" ] && continue
  count=$((count + 1))
  if [ "$version" != "$TAG_VERSION" ]; then
    echo "!! ${manifest} is at ${version}, tag ${TAG} expects ${TAG_VERSION}" >&2
    fail=1
  fi
done < <(node scripts/release-manifests.mjs read)

if [ "$count" -eq 0 ]; then
  echo "!! read no manifests at all; the release list is broken" >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "!! release aborted: run scripts/release.sh ${TAG_VERSION} so every manifest moves together" >&2
  exit 1
fi

echo "==> ${TAG} matches all ${count} manifests (${TAG_VERSION})"
