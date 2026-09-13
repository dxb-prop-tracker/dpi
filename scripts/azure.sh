#!/bin/bash
# One-off Azure chores for the private preview site. Needs `az login` done once on this Mac.
#   bash scripts/azure.sh create                      create the resource group + Static Web App (Free plan)
#   bash scripts/azure.sh invite <user> [github|aad]  make an invitation link (GitHub username, or email for Microsoft)
#   bash scripts/azure.sh users                       list who has accepted and with which role
#   bash scripts/azure.sh revoke <user> [github|aad]  remove someone's access
#   bash scripts/azure.sh url                         print the site address
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
APP="${SWA_APP:-dpi-preview}"
RG="${SWA_RG:-dpi-rg}"
LOC="${SWA_LOCATION:-westeurope}"

need_login() { az account show >/dev/null 2>&1 || { echo "not signed in to Azure — run: az login"; exit 3; }; }
host() { az staticwebapp show --name "$APP" --resource-group "$RG" --query defaultHostname -o tsv; }
prov() { case "${1:-github}" in github|GitHub) echo GitHub;; aad|microsoft|AAD) echo AAD;; *) echo "$1";; esac; }

case "$1" in
  create)
    need_login
    echo "subscription: $(az account show --query name -o tsv)"
    az group create --name "$RG" --location "$LOC" --output none && echo "resource group $RG ready"
    if az staticwebapp show --name "$APP" --resource-group "$RG" >/dev/null 2>&1; then
      echo "static web app $APP already exists"
    else
      az staticwebapp create --name "$APP" --resource-group "$RG" --location "$LOC" --sku Free --output none && echo "static web app $APP created (Free plan)"
    fi
    echo "address: https://$(host)/"
    ;;
  invite)
    need_login
    [ -n "$2" ] || { echo "usage: azure.sh invite <github-username-or-email> [github|aad]"; exit 1; }
    P=$(prov "$3"); H=$(host)
    ROLES="${ROLES:-friend}"
    URL=$(az staticwebapp users invite --name "$APP" --resource-group "$RG" --authentication-provider "$P" \
          --user-details "$2" --roles "$ROLES" --invitation-expiration-in-hours 168 --domain "$H" --query invitationUrl -o tsv)
    echo "invitation for $2 ($P, roles: $ROLES) — valid 7 days, one use:"
    echo "$URL"
    ;;
  users)
    need_login
    az staticwebapp users list --name "$APP" --resource-group "$RG" --query "[].{user:displayName,provider:provider,roles:roles}" -o table
    ;;
  revoke)
    need_login
    [ -n "$2" ] || { echo "usage: azure.sh revoke <user> [github|aad]"; exit 1; }
    P=$(prov "$3")
    az staticwebapp users update --name "$APP" --resource-group "$RG" --authentication-provider "$P" --user-details "$2" --roles "" --output none && echo "access removed for $2"
    ;;
  url) need_login; echo "https://$(host)/" ;;
  *) sed -n 2,8p "$0" ;;
esac
