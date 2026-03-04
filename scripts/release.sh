#!/usr/bin/env bash
set -euo pipefail

# DeClaw — local release script
# Usage:
#   bash scripts/release.sh patch    # 0.2.2 → 0.2.3
#   bash scripts/release.sh minor    # 0.2.2 → 0.3.0
#   bash scripts/release.sh major    # 0.2.2 → 1.0.0
#
# This script handles local-only steps (preflight, bump, commit, tag, push).
# CI (.github/workflows/release.yml) takes over from the tag push:
#   → build + test gate
#   → GitHub Release creation → triggers npm publish (publish.yml)
#   → ClawHub skill publish
#   → Backmerge main → develop

LEVEL="${1:-patch}"

if [[ "$LEVEL" != "patch" && "$LEVEL" != "minor" && "$LEVEL" != "major" ]]; then
  echo "Usage: bash scripts/release.sh [patch|minor|major]"
  exit 1
fi

echo "=== DeClaw Release (${LEVEL}) ==="

# ── 0. Preflight checks ──────────────────────────────────────────────────────

BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on 'main' branch (currently on '${BRANCH}')"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

git fetch origin main --quiet
LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse origin/main)
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "Error: local main ($LOCAL) differs from origin/main ($REMOTE). Pull or push first."
  exit 1
fi

# ── 1. Build + test ──────────────────────────────────────────────────────────

echo "Building..."
npm run build

echo "Running tests..."
node --test test/*.test.mjs

# ── 2. Version bump (package.json + openclaw.plugin.json + SKILL.md) ─────────

VERSION=$(npm version "$LEVEL" --no-git-tag-version | tr -d 'v')
echo "New version: ${VERSION}"

sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"${VERSION}\"/" openclaw.plugin.json
sed -i '' "s/^version: .*/version: ${VERSION}/" skills/declaw/SKILL.md

echo "Version synced to: package.json, openclaw.plugin.json, skills/declaw/SKILL.md"

# ── 3. Verify CHANGELOG ──────────────────────────────────────────────────────

if ! grep -q "\[${VERSION}\]" CHANGELOG.md; then
  echo ""
  echo "Warning: CHANGELOG.md does not contain a [${VERSION}] section."
  read -p "Continue without changelog entry? (y/N) " -n 1 -r
  echo
  if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    echo "Aborting. Update CHANGELOG.md and re-run."
    git checkout -- package.json package-lock.json openclaw.plugin.json skills/declaw/SKILL.md
    exit 1
  fi
fi

# ── 4. Commit + tag + push ───────────────────────────────────────────────────

git add -A
git commit -m "chore: release v${VERSION}"
git tag "v${VERSION}"
git push origin main --tags

echo ""
echo "=== Pushed v${VERSION} tag — CI takes over ==="
echo ""
echo "CI will automatically:"
echo "  1. Build + test gate"
echo "  2. Create GitHub Release → triggers npm publish"
echo "  3. Publish skill to ClawHub"
echo "  4. Backmerge main → develop"
echo ""
echo "Monitor: https://github.com/ReScienceLab/DeClaw/actions"
echo ""
echo "Manual steps (if needed):"
echo "  - Deploy bootstrap (if server.mjs changed)"
