#!/usr/bin/env bash
#
# Provisions the chatgpt-azure connector infrastructure and stores a freshly generated
# connector API key in Key Vault.
#
# Usage:
#   ./scripts/bootstrap/provision.sh <subscription-id> [environment] [location]
#
# Requires: az CLI (logged in), openssl.

set -euo pipefail

SUBSCRIPTION_ID="${1:?usage: provision.sh <subscription-id> [environment] [location]}"
ENVIRONMENT="${2:-prod}"
LOCATION="${3:-westeurope}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d%H%M%S)"

echo "==> Using subscription ${SUBSCRIPTION_ID}"
az account set --subscription "${SUBSCRIPTION_ID}"

# The Container App mounts the connector API key straight out of Key Vault, so it cannot be
# created until that secret exists. Pass 1 stands up the vault and the identity, we write the
# secret, and pass 2 brings the app up.
FOUNDATION_DEPLOYMENT="chatgpt-azure-${ENVIRONMENT}-foundation-${STAMP}"
echo "==> Deploying foundation: identity, registry, vault, logs, RBAC (${FOUNDATION_DEPLOYMENT})"
az deployment sub create \
  --name "${FOUNDATION_DEPLOYMENT}" \
  --location "${LOCATION}" \
  --template-file "${REPO_ROOT}/infra/main.bicep" \
  --parameters environmentName="${ENVIRONMENT}" location="${LOCATION}" deployApp=false \
  --output none

read_output() {
  az deployment sub show --name "${FOUNDATION_DEPLOYMENT}" \
    --query "properties.outputs.$1.value" --output tsv
}

RESOURCE_GROUP="$(read_output resourceGroupName)"
KEY_VAULT="$(read_output keyVaultName)"
REGISTRY="$(read_output registryLoginServer)"
IDENTITY_CLIENT_ID="$(read_output identityClientId)"

# The vault uses RBAC authorisation, so subscription Owner alone does not grant data-plane
# access. Grant the operator the secrets role and wait for it to propagate.
CALLER_ID="$(az ad signed-in-user show --query id --output tsv)"
VAULT_ID="$(az keyvault show --name "${KEY_VAULT}" --resource-group "${RESOURCE_GROUP}" --query id --output tsv)"
if ! az role assignment list --assignee "${CALLER_ID}" --scope "${VAULT_ID}" \
  --query "[?roleDefinitionName=='Key Vault Secrets Officer'] | [0]" --output tsv | grep -q .; then
  echo "==> Granting the current user Key Vault Secrets Officer on ${KEY_VAULT}"
  az role assignment create \
    --assignee-object-id "${CALLER_ID}" \
    --assignee-principal-type User \
    --role "Key Vault Secrets Officer" \
    --scope "${VAULT_ID}" \
    --output none
  echo "    Waiting for the role assignment to propagate"
  sleep 45
fi

echo "==> Ensuring a connector API key exists in ${KEY_VAULT}"
if ! az keyvault secret show --vault-name "${KEY_VAULT}" --name connector-api-key --output none 2>/dev/null; then
  API_KEY="$(openssl rand -hex 32)"
  az keyvault secret set \
    --vault-name "${KEY_VAULT}" \
    --name connector-api-key \
    --value "${API_KEY}" \
    --output none
  echo "    Generated a new connector API key. Retrieve it with:"
  echo "    az keyvault secret show --vault-name ${KEY_VAULT} --name connector-api-key --query value -o tsv"
else
  echo "    Existing connector API key left untouched."
fi

# The app's ingress hostname is derived from the managed environment domain, which only exists
# after the app deployment. Deploy once to create it, then read the FQDN back; deploy.sh keeps
# PUBLIC_BASE_URL correct from then on.
APP_DEPLOYMENT="chatgpt-azure-${ENVIRONMENT}-app-${STAMP}"
echo "==> Deploying the Container App (${APP_DEPLOYMENT})"
az deployment sub create \
  --name "${APP_DEPLOYMENT}" \
  --location "${LOCATION}" \
  --template-file "${REPO_ROOT}/infra/main.bicep" \
  --parameters environmentName="${ENVIRONMENT}" location="${LOCATION}" \
  --output none

CONNECTOR_URL="$(az deployment sub show --name "${APP_DEPLOYMENT}" \
  --query "properties.outputs.connectorUrl.value" --output tsv)"

cat <<SUMMARY

==> Bootstrap complete

  Resource group        ${RESOURCE_GROUP}
  Container registry    ${REGISTRY}
  Key Vault             ${KEY_VAULT}
  Identity client id    ${IDENTITY_CLIENT_ID}
  Connector URL         ${CONNECTOR_URL}

The app is currently running the placeholder image, and because the ingress hostname does not
exist until the app is created, PUBLIC_BASE_URL is not set yet — the OpenAPI document will
advertise localhost until you run deploy.sh, which supplies the real hostname. Do not register
the connector in ChatGPT before then.

Next steps:
  1. Build and push the real image:
       ./scripts/bootstrap/deploy.sh ${SUBSCRIPTION_ID} ${ENVIRONMENT} ${LOCATION}
  2. Register the connector in ChatGPT using ${CONNECTOR_URL}/openapi.json
     with the API key from Key Vault as the bearer token.

SUMMARY
