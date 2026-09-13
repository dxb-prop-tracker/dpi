#!/bin/bash
# Uploads the built site (dist/) to the private Azure Static Web App.
# Runs at the end of every daily refresh (scripts/daily-refresh.sh) and by hand with:  npm run deploy
#
# Access: the site is locked by staticwebapp.config.json — every page needs an invited login
# (role "friend"); invitations are issued with:  npm run invite -- <github-username-or-email> [github|aad]
#
# Credentials: none are stored in the project. The deployment token is fetched at run time from
# Azure with the signed-in Azure CLI (`az login` once on this Mac) and handed to the uploader in
# memory only. Nothing but static HTML/CSS/JS leaves the Mac — no database, no API keys.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$(dirname "$0")/.." || exit 1

APP="${SWA_APP:-dpi-preview}"
RG="${SWA_RG:-dpi-rg}"
STAGE=".deploy"

say() { echo "$(date '+%F %T')  $*"; }

command -v az >/dev/null || { say "az (Azure CLI) is not installed — see scripts/azure.sh"; exit 2; }
command -v swa >/dev/null || { say "swa (Static Web Apps CLI) is not installed — npm install -g @azure/static-web-apps-cli"; exit 2; }
[ -d dist ] && [ -f dist/index.html ] || { say "dist/ is missing — run npm run build first"; exit 2; }
[ -f dist/login/index.html ] || { say "dist/login/index.html missing — the sign-in page did not build"; exit 2; }

# 1. Stage a copy of dist without the Listings section (scraped feed data stays off any hosted copy).
say "staging dist → $STAGE (without /listings)"
rm -rf "$STAGE"; mkdir -p "$STAGE"
rsync -a --delete --exclude '/listings/' dist/ "$STAGE"/
mkdir -p "$STAGE/listings"
cat > "$STAGE/listings/index.html" <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Listings — not in the preview</title>
<style>body{font-family:Inter,system-ui,sans-serif;background:#faf7f2;color:#221f1a;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
.c{max-width:520px;background:#fffdf9;border:1px solid rgba(34,31,26,.12);border-radius:14px;padding:28px}h1{font-family:Fraunces,Georgia,serif;font-weight:600;font-size:24px;margin:0 0 8px}p{color:#57524a;font-size:14.5px}a{color:#0e5c63}</style></head>
<body><div class="c"><h1>Listings are not part of this preview</h1><p>Asking-price listings will appear once a licensed feed is in place. Everything else on the site — recorded sales, rents, project delivery histories, developer credit views and the weekly, monthly and yearly reports — is here.</p><p><a href="/">Back to the front page</a></p></div></body></html>
HTML
cp staticwebapp.config.json "$STAGE"/
SIZE=$(du -sm "$STAGE" | cut -f1); FILES=$(find "$STAGE" -type f | wc -l | tr -d ' ')
say "staged ${SIZE} MB in ${FILES} files (Free plan ceiling 250 MB, Standard 500 MB)"
[ "$SIZE" -gt 240 ] && say "WARNING: the site is close to the Free plan's 250 MB limit — upgrade the plan to Standard"

# 2. Fetch the deployment token from Azure (never written to disk) and upload.
if ! az account show >/dev/null 2>&1; then say "not signed in to Azure — run: az login"; exit 3; fi
TOKEN=$(az staticwebapp secrets list --name "$APP" --resource-group "$RG" --query properties.apiKey -o tsv 2>/dev/null)
[ -n "$TOKEN" ] || { say "could not read the deployment token for $APP in $RG — does the Static Web App exist? (npm run azure:create)"; exit 3; }

say "uploading to $APP …"
SWA_CLI_DEPLOYMENT_TOKEN="$TOKEN" swa deploy "$STAGE" --env production 2>&1 | sed 's/^/  /'
rc=${PIPESTATUS[0]}
unset TOKEN SWA_CLI_DEPLOYMENT_TOKEN
HOST=$(az staticwebapp show --name "$APP" --resource-group "$RG" --query defaultHostname -o tsv 2>/dev/null)
if [ "$rc" -eq 0 ]; then say "deployed — https://$HOST/"; else say "deploy FAILED (exit $rc)"; fi
exit $rc
