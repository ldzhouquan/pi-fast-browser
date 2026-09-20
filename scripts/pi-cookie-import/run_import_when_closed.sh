#!/bin/bash
# Wait for PI-Desktop to fully exit, then import Chrome cookies into
# PI-Desktop's work-browser cookie DB. Logs progress to import.log.
# Usage: ./run_import_when_closed.sh &   (run in background, then quit PI-Desktop)
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="$DIR/import.log"
PY="$(command -v python3 || true)"

echo "$(date '+%F %T') watcher started, waiting for PI-Desktop to exit..." >> "$LOG"

# Wait for the main PI-Desktop process to be gone
while pgrep -x "PI-Desktop" > /dev/null 2>&1; do
  sleep 3
done

# Double-check it's really gone (some helpers linger)
sleep 2
if pgrep -x "PI-Desktop" > /dev/null 2>&1; then
  echo "$(date '+%F %T') ERROR: PI-Desktop still running, aborting." >> "$LOG"
  exit 1
fi

echo "$(date '+%F %T') PI-Desktop exited. Starting import..." >> "$LOG"
cd "$DIR"
if "$PY" "$DIR/import_cookies.py" >> "$LOG" 2>&1; then
  echo "$(date '+%F %T') IMPORT COMPLETE. You can now reopen PI-Desktop." >> "$LOG"
else
  echo "$(date '+%F %T') IMPORT FAILED - see messages above." >> "$LOG"
  exit 1
fi
