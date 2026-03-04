#!/usr/bin/env bash
# Run the DeClaw two-node P2P simulation locally.
# Builds docker images, starts alice + bob, streams logs, shows pass/fail.
#
# Requirements:
#   - Docker Desktop with Linux containers
#   - Internet access (Yggdrasil public peers + DeClaw bootstrap nodes)
#
# Usage:
#   bash docker/run-sim.sh [--build]   # --build forces image rebuild

set -euo pipefail

cd "$(dirname "$0")/.."  # repo root

# Load ANTHROPIC_API_KEY from docker/.env if not already in environment
if [[ -f docker/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source docker/.env
  set +a
fi

COMPOSE="docker compose -f docker/docker-compose.sim.yml"
BUILD_FLAG=""
[[ "${1:-}" == "--build" ]] && BUILD_FLAG="--build"

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║          DeClaw Agent-to-Agent P2P Simulation                   ║"
echo "║  alice (Claude)  ←→  Yggdrasil mesh  ←→  bob (Claude)          ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo ""
echo "Each container:"
echo "  1. Starts Yggdrasil → gets a real 200::/7 address"
echo "  2. Starts DeClaw peer server (testMode: false)"
echo "  3. Announces to real DeClaw AWS bootstrap nodes"
echo "  4. bob:   generates opening message via Claude, sends to alice"
echo "     alice: replies with Claude — 3 rounds bidirectional"
echo ""
echo "ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:+configured ✓}${ANTHROPIC_API_KEY:-NOT SET — agents will echo only}"
echo ""

# Clean up leftovers from previous run
$COMPOSE down -v 2>/dev/null || true

echo "── Building images ────────────────────────────────────────────────"
$COMPOSE build $BUILD_FLAG
echo ""

echo "── Starting simulation ────────────────────────────────────────────"
echo "Streaming logs (Ctrl+C to abort)..."
echo ""

set +e
$COMPOSE up \
  --no-color \
  --remove-orphans \
  --abort-on-container-exit \
  --exit-code-from alice 2>&1 | tee /tmp/declaw-sim.log
SIM_EXIT=$?
set -e

echo ""
echo "── Cleaning up ────────────────────────────────────────────────────"
$COMPOSE down -v 2>/dev/null || true

echo ""
# Parse results from combined log
ALICE_PASS=$(grep -c "\[alice\] PASS" /tmp/declaw-sim.log 2>/dev/null || true)
BOB_PASS=$(grep -c "\[bob\] PASS" /tmp/declaw-sim.log 2>/dev/null || true)

echo "╔══════════════════════════════════════════════════════════════════╗"
if [[ "$ALICE_PASS" -gt 0 && "$BOB_PASS" -gt 0 ]]; then
  echo "║  RESULT: PASSED                                                 ║"
  echo "║  ✓ alice received bob's message                                 ║"
  echo "║  ✓ bob's message was delivered                                  ║"
  echo "║  Real Yggdrasil P2P communication confirmed!                    ║"
elif [[ "$BOB_PASS" -gt 0 ]]; then
  echo "║  RESULT: PARTIAL — bob sent, alice log may be missing           ║"
elif [[ "$ALICE_PASS" -gt 0 ]]; then
  echo "║  RESULT: PARTIAL — alice received, bob may have failed          ║"
else
  echo "║  RESULT: FAILED (exit code: $SIM_EXIT)                              ║"
  echo "║  Check /tmp/declaw-sim.log for details                          ║"
fi
echo "╚══════════════════════════════════════════════════════════════════╝"

[[ "$ALICE_PASS" -gt 0 && "$BOB_PASS" -gt 0 ]] && exit 0 || exit ${SIM_EXIT:-1}
