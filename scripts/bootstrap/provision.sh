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
DEPLOYMENT_NAME="chatgpt-azure-${ENVIRONMENT}-$(date +%Y%m%d%H%M%S)"

echo "==> Using subscription ${SUBSCRIPTION_ID}"
az account set --subscription "${SUBSCRIPTION_ID}"

echo "==> Deploying infrastructure (${DEPLOYMENT_NAME})"
az deployment sub create \
  --name "${DEPLOYMENT_NAME}" \
  --location "${LOCATION}" \
  --template-file "${REPO_ROOT}/infra/main.bicep" \
  --parameters environmentName="${ENVIRONMENT}" location="${LOCATION}" \
  --output none

read_output() {
  az deployment sub show --name "${DEPLOYMENT_NAME}" \
    --query "properties.outputs.$1.value" --output tsv
}

RESOURCE_GROUP="$(read_output resourceGroupName)"
KEY_VAULT="$(read_output keyVaultName)"
REGISTRY="$(read_output registryLoginServer)"
IDENTITY_CLIENT_ID="$(read_output identityClientId)"
CONNECTOR_URL="$(read_output connectorUrl)"

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

cat <<SUMMARY

==> Bootstrap complete

  Resource group        ${RESOURCE_GROUP}
  Container registry    ${REGISTRY}
  Key Vault             ${KEY_VAULT}
  Identity client id    ${IDENTITY_CLIENT_ID}
  Connector URL         ${CONNECTOR_URL}

Next steps:
  1. Build and push the image:
       ./scripts/bootstrap/deploy.sh ${SUBSCRIPTION_ID} ${ENVIRONMENT} ${LOCATION}
  2. Register the connector in ChatGPT using ${CONNECTOR_URL}/openapi.json
     with the API key from Key Vault as the bearer token.

SUMMARY
