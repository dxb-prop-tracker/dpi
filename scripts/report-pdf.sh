#!/bin/bash
# Print report editions to PDF with Chrome (headless): the newest weekly, monthly and yearly edition,
# or one edition given as "<kind> <key>" (e.g. monthly 2026-08). Output: reports/DPI-<kind>-<key>.pdf.
# Never fails the refresh chain.
cd "$(dirname "$0")/.." || exit 0
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || CHROME="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
[ -n "$CHROME" ] || { echo "report:pdf — Chrome not found; open the page and use Print / save as PDF"; exit 0; }
mkdir -p reports
# The built page loads its stylesheet from /_astro/…, so it must be served over HTTP, not opened as a file.
PORT=4398
python3 -m http.server "$PORT" --directory dist --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!
sleep 1.5
print_one() {
  local kind="$1" key="$2"
  local html="dist/reports/$kind/$key/index.html" out="reports/DPI-$kind-$key.pdf"
  [ -f "$html" ] || { echo "report:pdf — no built page for $kind $key"; return; }
  [ -s "$out" ] && [ "$out" -nt "$html" ] && { echo "report:pdf — $out is up to date"; return; }
  "$CHROME" --headless=new --disable-gpu --no-sandbox --no-pdf-header-footer --virtual-time-budget=15000 --print-to-pdf="$out" "http://127.0.0.1:$PORT/reports/$kind/$key/" >/dev/null 2>&1
  if [ -s "$out" ]; then echo "report:pdf — wrote $out"; else echo "report:pdf — Chrome produced no file for $kind $key"; fi
}
if [ -n "$1" ] && [ -n "$2" ]; then print_one "$1" "$2"
else
  for kind in weekly monthly yearly; do
    key="$(ls data/reports/$kind/*.json 2>/dev/null | sed 's#.*/##; s#\.json##' | sort | tail -1)"
    [ -n "$key" ] && print_one "$kind" "$key"
  done
fi
kill $SRV >/dev/null 2>&1
exit 0
