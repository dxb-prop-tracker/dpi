#!/bin/bash
# Recalculate a workbook and write a copy whose cached values are fresh.
#   bash scripts/recalc.sh in.xlsx out.xlsx
# LibreOffice first (headless, deterministic — it is what CI and the cloud have), Excel on a Mac
# otherwise, under a watchdog because Excel's AppleScript bridge hangs on any open dialog. Refuses
# with a clear message if neither works — a parity proof that quietly skipped would not be a proof.
IN="$1"; OUT="$2"
[ -f "$IN" ] || { echo "recalc: no such file $IN" >&2; exit 2; }
case "$(basename "$IN")" in '~$'*) echo "recalc: $IN is an Excel lock file, not a workbook" >&2; exit 2;; esac
ABS_IN=$(cd "$(dirname "$IN")" && pwd)/$(basename "$IN")
mkdir -p "$(dirname "$OUT")"
ABS_OUT=$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")

SOFFICE=$(command -v soffice || command -v libreoffice || ls /Applications/LibreOffice.app/Contents/MacOS/soffice 2>/dev/null)
if [ -n "$SOFFICE" ]; then
  TMP=$(mktemp -d); PROF=$(mktemp -d)
  "$SOFFICE" --headless --norestore "-env:UserInstallation=file://$PROF" --convert-to xlsx --outdir "$TMP" "$ABS_IN" >/dev/null 2>&1
  f=$(ls "$TMP"/*.xlsx 2>/dev/null | head -1)
  if [ -n "$f" ]; then mv "$f" "$ABS_OUT"; echo "recalc: LibreOffice"; exit 0; fi
  echo "recalc: LibreOffice ran but produced nothing" >&2
fi

# Run an AppleScript with a watchdog: osascript never returns while Excel shows a dialog.
excel_script() {
  osascript >/dev/null 2>&1 <<APPLESCRIPT &
$1
APPLESCRIPT
  local pid=$! t=0
  while kill -0 $pid 2>/dev/null; do sleep 1; t=$((t+1)); [ $t -ge 90 ] && { kill $pid 2>/dev/null; echo "recalc: Excel did not answer within 90s (a dialog is probably open in Excel)" >&2; return 1; }; done
  wait $pid
}
if [ "$(uname)" = "Darwin" ] && [ -d "/Applications/Microsoft Excel.app" ]; then
  rm -f "$ABS_OUT"
  excel_script "tell application \"Microsoft Excel\"
  set wb to open workbook workbook file name \"$ABS_IN\"
  calculate
  save workbook as wb filename \"$ABS_OUT\" file format Excel XML file format with overwrite
  close wb saving no
end tell"
  if [ -f "$ABS_OUT" ]; then echo "recalc: Excel"; exit 0; fi
  echo "recalc: Excel is installed but did not produce $ABS_OUT" >&2
fi
echo "recalc: neither LibreOffice nor Excel could recalculate on this machine" >&2
exit 3
