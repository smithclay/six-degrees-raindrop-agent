#!/usr/bin/env bash
# Run the agent over every pair in pairs.tsv (CONCURRENCY at a time) to seed Raindrop with events.
set -u
cd "$(dirname "$0")"
mkdir -p logs
CONCURRENCY="${CONCURRENCY:-3}"
tr '\t' '\n' < "${1:-pairs.tsv}" | tr '\n' '\0' | xargs -0 -n2 -P "$CONCURRENCY" sh -c '
  log="logs/$(printf "%s__%s" "$1" "$2" | tr -c "A-Za-z0-9_" "-").log"
  npx tsx agent.ts "$1" "$2" > "$log" 2>&1
  printf "%s → %s: %s\n" "$1" "$2" "$(grep -E "^(✅|❌)" "$log" | head -1 | cut -c1-120)"
' _
