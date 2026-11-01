#!/usr/bin/env bash
# Judge accuracy gate for a judge that runs without temperature (Claude 5.5).
# Used by .github/workflows/eval.yml (PR gate) and judge-canary.yml (weekly).
#
# Usage (from packages/api): bash scripts/judge-gate.sh <eval-set.json>
#
# poc-accuracy.ts exits 0 (pass), 2 (a floor failed) or 3 (instrument
# degraded: at least one item fell to the keyword fallback — provider error,
# credit, rate limit — so the numbers measure the fallback, not the judge).
# Any other code (a crash) passes straight through, so the gate fails closed.
#
#  - Exit 3 is retried once after a pause (three false fails on 2026-07-16).
#  - Exit 2 is re-run once. The Claude 5.5 family takes no temperature, so the
#    same code scores differently run to run: Haiku 5.5 passed 4 of 5 recorded
#    runs (eval/README.md). If runs are independent, one re-run brings a false
#    fail to about 1 in 25, while a judge that misses the floor every run still
#    fails. With a temperature-0 judge this re-run would only hide a failure.
#
# The exit code is the last run's.
set -u

eval_set="${1:?usage: bash scripts/judge-gate.sh <eval-set.json>}"
# Overridable only so the decision-table test does not sleep.
readonly RETRY_PAUSE_SECONDS="${JUDGE_GATE_RETRY_PAUSE_SECONDS:-60}"

score() {
  npx tsx scripts/poc-accuracy.ts --in="$eval_set" --concurrency=2 --delay=500
}

score_with_outage_retry() {
  score
  local code=$?
  if [ "$code" = "3" ]; then
    echo "::warning::Instrument degraded (provider unreachable) — retrying once in ${RETRY_PAUSE_SECONDS}s"
    sleep "$RETRY_PAUSE_SECONDS"
    score
    code=$?
  fi
  return "$code"
}

score_with_outage_retry
code=$?
if [ "$code" = "2" ]; then
  echo "::warning::A floor failed on the first run. The judge takes no temperature, so one re-run decides."
  score_with_outage_retry
  code=$?
  if [ "$code" = "0" ]; then
    echo "::warning::The re-run passed. The first run's numbers are above in this log — a change that keeps failing first runs is a regression even while this gate is green."
  fi
fi
exit "$code"
