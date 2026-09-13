#!/bin/bash
# Raise an alarm a person will actually see. A failure that only lands in a log file is a failure
# nobody knows about — the deploy failed for five days straight before anyone looked.
#   bash scripts/notify.sh "subject" [logfile]
SUBJ="$1"; LOG="$2"
TO="tammam.elbarbir@gmail.com"
BODY="$SUBJ
$(date '+%F %T')

$( [ -n "$LOG" ] && tail -25 "$LOG" )"
# 1. a persistent marker the next run and the next person can see
mkdir -p logs; printf '%s  %s\n' "$(date '+%F %T')" "$SUBJ" >> logs/ALERTS.log
# 2. a macOS notification
osascript -e "display notification \"$SUBJ\" with title \"DPI\"" >/dev/null 2>&1
# 3. an email through Mail.app, if it is configured
osascript <<APPLESCRIPT >/dev/null 2>&1
tell application "Mail"
  set m to make new outgoing message with properties {subject:"$SUBJ", content:"$BODY", visible:false}
  tell m to make new to recipient at end of to recipients with properties {address:"$TO"}
  send m
end tell
APPLESCRIPT
