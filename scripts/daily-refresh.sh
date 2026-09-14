#!/bin/bash
# Daily DLD refresh, run by launchd (see scripts/com.dpi.refresh.plist) at 15:00 Dubai time,
# with a second chance at 20:00 that only runs if the 15:00 run did not succeed.
# Runs `npm run refresh` in the project folder, then uploads the built site to the private
# Azure Static Web App (scripts/deploy-swa.sh), and keeps a log per day in logs/.
# Run it by hand with:  bash scripts/daily-refresh.sh   (add --force to run even if today already succeeded)
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
LOG="logs/refresh-$(date +%Y%m%d).log"

# Already refreshed successfully today? Then the 20:00 second chance has nothing to do.
if [ "$1" != "--force" ] && grep -q 'exit code 0' "$LOG" 2>/dev/null; then
  echo "$(date '+%F %T')  today's refresh already succeeded — nothing to do" >> "$LOG"
  exit 0
fi

# Never run two refreshes at once (a hand-started one and the 15:00 one, say).
if ! mkdir logs/.running 2>/dev/null; then
  echo "$(date '+%F %T')  another refresh is still running — skipped" >> "$LOG"
  exit 0
fi
trap 'rmdir logs/.running 2>/dev/null' EXIT

{
  echo "=== refresh started $(date '+%F %T') ==="
  npm run refresh
  rc=$?
  echo "=== refresh finished $(date '+%F %T') — exit code $rc ($([ $rc -eq 0 ] && echo OK || echo FAILED)) ==="
  # Upload the freshly built site to the private preview. A failed upload is logged but does not
  # count as a failed refresh (the 20:00 run would otherwise redo the whole 30-minute pull).
  if [ $rc -eq 0 ]; then
    echo "=== preship gate started $(date '+%F %T') ==="
    bash scripts/preship.sh --quick; prc=$?
    echo "=== preship gate finished $(date '+%F %T') — exit code $prc ==="
    if [ $prc -ne 0 ]; then
      bash scripts/notify.sh "DPI refresh: PRESHIP GATE FAILED — site NOT deployed" "$LOG"
      rc=$prc
    else
      # Deploy switched off on 14 September 2026 (Tammam): this repository is the test bed and
      # Ali's site is the product; nothing here is published for readers, and no Azure
      # subscription of our own exists to deploy into (the step had failed every day since
      # 7 September with "not signed in"). Set DPI_DEPLOY=1 to run it again.
      if [ "${DPI_DEPLOY:-0}" = "1" ]; then
        echo "=== deploy started $(date '+%F %T') ==="
        bash scripts/deploy-swa.sh; drc=$?
        echo "=== deploy finished $(date '+%F %T') — exit code $drc ($([ $drc -eq 0 ] && echo OK || echo FAILED, site unchanged) ==="
        if [ $drc -ne 0 ]; then
          bash scripts/notify.sh "DPI refresh: DEPLOY FAILED (exit $drc) — live site is stale" "$LOG"
        fi
      else
        echo "=== deploy skipped $(date '+%F %T') — switched off; the gate is the end of the run ==="
      fi
    fi
  else
    bash scripts/notify.sh "DPI refresh: REFRESH FAILED (exit $rc)" "$LOG"
  fi
} >> "$LOG" 2>&1

# Keep a month of logs.
find logs -name 'refresh-*.log' -mtime +31 -delete 2>/dev/null
exit $rc
