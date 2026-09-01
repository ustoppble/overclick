#!/usr/bin/env bash
# Cut a release: bump every manifest, commit, tag, push (OCL-158).
#
# Before this script, cutting a release was five steps done by hand — bump
# eleven manifests, commit, tag, push, then create the GitHub Release — and
# only the last one feeds the update check in apps/web/src/lib/updates.ts,
# which compares the running version against the LATEST GitHub Release.
# Nothing complained when it was skipped: on 2026-08-31, v0.3.2 and v0.3.3
# both published an image to ghcr and neither created a Release, so the
# hosted instance sat on v0.3.1 without ever showing a banner. The Release is
# now the workflow's job on tag push; this script is the other four steps.
#
# Usage:
#   scripts/release.sh 0.3.7 "notes.md"   notes read from a file
#   scripts/release.sh 0.3.7              notes read from stdin
#
# The notes become the release commit body, and the workflow lifts them from
# there into the GitHub Release, so the changelog is written once.
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  echo "!! usage: scripts/release.sh <version> [notes-file]" >&2
  exit 1
fi
if ! printf '%s' "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'; then
  echo "!! ${VERSION} is not a version; write it without the leading v" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "!! the working tree is dirty; a release commit must carry only the bump" >&2
  git status --short >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" != "main" ]; then
  echo "!! on ${BRANCH}; releases are cut from main" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null; then
  echo "!! tag v${VERSION} already exists" >&2
  exit 1
fi

NOTES_FILE="${2:-}"
if [ -n "$NOTES_FILE" ]; then
  NOTES="$(cat "$NOTES_FILE")"
else
  echo "==> reading release notes from stdin (end with ctrl-d)"
  NOTES="$(cat)"
fi
if [ -z "${NOTES//[[:space:]]/}" ]; then
  echo "!! empty notes: they become the GitHub Release body, so write them" >&2
  exit 1
fi

echo "==> bumping every manifest to ${VERSION}"
node scripts/release-manifests.mjs write "$VERSION"

echo "==> checking the bump against the tag it is about to get"
scripts/verify-release-version.sh "v${VERSION}"

git add --update
printf 'release: v%s\n\n%s\n' "$VERSION" "$NOTES" | git commit -q -F -
git tag "v${VERSION}"

echo "==> pushing main and v${VERSION}"
git push -q origin main
git push -q origin "v${VERSION}"

echo "==> v${VERSION} is out; the workflow builds the image and creates the Release"
