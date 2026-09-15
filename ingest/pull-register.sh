#!/bin/bash
# B18 — bring the register workbook down from Azure Blob, with no Dropbox in the middle.
#
# WHY: the register export runs in the cloud (Container Apps job `uae-daily-refresh`) and a
# container cannot reach Dropbox, so it uploads the workbook to the `register-export` container.
# Until now this machine picked it up out of a Dropbox folder that Ali's Mac had synced for it —
# a file exchange neither side controls, and Ali's rule since 15 September is that there isn't one.
# This script reads the container directly, so the only hop is Blob -> here.
#
#   bash ingest/pull-register.sh           # newest, if we do not already have it
#   bash ingest/pull-register.sh --force   # re-download even if present
#   bash ingest/pull-register.sh --list    # what is in the container
#
# Needs the az CLI signed in with Storage Blob Data Reader on the storage account. It never asks
# for or stores a credential of its own: `--auth-mode login` uses the session az already holds.
set -euo pipefail

ACCOUNT="${CHAIN_STORAGE_ACCOUNT:-hkaspropertydata}"
CONTAINER="${CHAIN_REGISTER_CONTAINER:-register-export}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${REGISTER_DIR:-$ROOT/data/register}"

command -v az >/dev/null || { echo "pull-register: the az CLI is not installed." >&2; exit 2; }
az account show >/dev/null 2>&1 || {
  echo "pull-register: az is not signed in. Run 'az login' yourself — this script will not." >&2
  exit 2; }

blob() { az storage blob "$@" --auth-mode login --account-name "$ACCOUNT" --container-name "$CONTAINER"; }

if [[ "${1:-}" == "--list" ]]; then
  blob list --query '[].{name:name,KB:properties.contentLength,modified:properties.lastModified}' -o tsv \
    | awk -F'\t' '{printf "  %-46s %7.0f KB  %s\n", $1, $2/1024, $3}'
  exit 0
fi

# latest.json is written by the job in the same step as the workbook, so it names the file that
# actually landed. Sorting blob names and taking the last one guesses; this does not. The fallback
# below exists only for the case where the job wrote a workbook and died before the pointer.
# az writes its own progress bar to stdout, so latest.json goes to a file and is read back from
# there — piping the download through stdout silently mixed the bar into the JSON and the fallback
# fired every time, which is exactly the guess the pointer exists to avoid.
PTR=$(mktemp)
trap 'rm -f "$PTR"' EXIT
LATEST=$(blob download --name latest.json --file "$PTR" --output none >/dev/null 2>&1 \
         && python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$PTR" 2>/dev/null || true)
if [[ -z "${LATEST:-}" ]]; then
  echo "pull-register: no latest.json in $CONTAINER — falling back to the newest workbook name." >&2
  LATEST=$(blob list --prefix Dubai_Project_Register_ --query '[].name' -o tsv | grep -v '^smoke/' | sort | tail -1)
fi
[[ -n "${LATEST:-}" ]] || { echo "pull-register: $CONTAINER holds no register workbook." >&2; exit 1; }

mkdir -p "$DEST"
if [[ -f "$DEST/$LATEST" && "${1:-}" != "--force" ]]; then
  echo "pull-register: already have $LATEST — nothing to do."
  echo "$DEST/$LATEST"
  exit 0
fi

# Download beside the target and move into place, so the loader never opens a half-written workbook.
TMP="$DEST/.$LATEST.part"
echo "pull-register: downloading $LATEST ..." >&2
blob download --name "$LATEST" --file "$TMP" --output none
mv -f "$TMP" "$DEST/$LATEST"
echo "pull-register: $DEST/$LATEST ($(du -h "$DEST/$LATEST" | cut -f1))" >&2
echo "$DEST/$LATEST"
