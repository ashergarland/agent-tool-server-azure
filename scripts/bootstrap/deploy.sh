#!/usr/bin/env bash
#
# Builds the connector image in Azure Container Registry and redeploys the Container App
# pointing at the new tag.
#
# Usage:
#   ./scripts/bootstrap/deploy.sh <subscription-id> [environment] [location]
#
# Requires: az CLI (logged in), git.

set -euo pipefail

SUBSCRIPTION_ID="${1:?usage: deploy.sh <subscription-id> [environment] [location]}"
ENVIRONMENT="${2:-prod}"
LOCATION="${3:-westeurope}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESOURCE_GROUP="rg-chatgpt-azure-${ENVIRONMENT}"
TAG="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"

az account set --subscription "${SUBSCRIPTION_ID}"

REGISTRY_NAME="$(az acr list --resource-group "${RESOURCE_GROUP}" --query '[0].name' --output tsv)"
if [[ -z "${REGISTRY_NAME}" ]]; then
  echo "No container registry found in ${RESOURCE_GROUP}. Run provision.sh first." >&2
  exit 1
fi
REGISTRY_SERVER="$(az acr show --name "${REGISTRY_NAME}" --query loginServer --output tsv)"
IMAGE="${REGISTRY_SERVER}/chatgpt-azure:${TAG}"

echo "==> Building ${IMAGE} in ACR"
az acr build \
  --registry "${REGISTRY_NAME}" \
  --image "chatgpt-azure:${TAG}" \
  --build-arg "GIT_SHA=${TAG}" \
  --file "${REPO_ROOT}/Dockerfile" \
  "${REPO_ROOT}" \
  --output none

APP_NAME="ca-chatgpt-azure-${ENVIRONMENT}"
FQDN="$(az containerapp show --name "${APP_NAME}" --resource-group "${RESOURCE_GROUP}" \
  --query properties.configuration.ingress.fqdn --output tsv)"

echo "==> Redeploying ${APP_NAME} with the new image"
az deployment sub create \
  --name "chatgpt-azure-${ENVIRONMENT}-$(date +%Y%m%d%H%M%S)" \
  --location "${LOCATION}" \
  --template-file "${REPO_ROOT}/infra/main.bicep" \
  --parameters \
    environmentName="${ENVIRONMENT}" \
    location="${LOCATION}" \
    image="${IMAGE}" \
    publicBaseUrl="https://${FQDN}" \
  --output none

echo "==> Deployed. Verifying health"
curl -fsS "https://${FQDN}/health" && echo
echo "OpenAPI: https://${FQDN}/openapi.json"
