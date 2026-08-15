#!/usr/bin/env bash
#
# Builds the server image in Azure Container Registry and releases it to an existing environment.
#
# Usage:
#   ./scripts/bootstrap/deploy.sh <subscription-id> <environment> <location>
#
# This is an image-only release. Everything except the image, its digest, the git SHA, the service
# version and the public URL comes from infra/parameters/<environment>.parameters.json, which is
# passed on every deployment. That is what stops a release from resetting resource group
# restrictions, mutation state, deployment state, alerts, replicas or tags back to Bicep defaults.
#
# Requires: az CLI (signed in), jq, git, node.

set -euo pipefail

# shellcheck source=../lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/common.sh"

SUBSCRIPTION_ID="${1:?usage: deploy.sh <subscription-id> <environment> <location>}"
ENVIRONMENT="${2:?usage: deploy.sh <subscription-id> <environment> <location>}"
LOCATION="${3:?usage: deploy.sh <subscription-id> <environment> <location>}"

require_tools az jq git node
PARAMETERS="$(parameter_file "${ENVIRONMENT}")"
preflight "${SUBSCRIPTION_ID}" "${ENVIRONMENT}"

if [[ -n "$(git -C "${REPO_ROOT}" status --porcelain)" ]]; then
  warn "The working tree has uncommitted changes; the recorded git SHA will not describe the image."
  confirm "Release from a dirty working tree?"
fi

GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
SHORT_SHA="${GIT_SHA:0:12}"
VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"
RESOURCE_GROUP="rg-agent-tool-server-azure-${ENVIRONMENT}"

REGISTRY_NAME="$(az acr list --resource-group "${RESOURCE_GROUP}" --query '[0].name' --output tsv)"
[[ -n "${REGISTRY_NAME}" ]] || die "No container registry in ${RESOURCE_GROUP}. Run provision.sh first."
REGISTRY_SERVER="$(az acr show --name "${REGISTRY_NAME}" --query loginServer --output tsv)"

# The tag is immutable by construction: it names one commit and is never reused for another. The
# deployment then references the digest, so what runs cannot change underneath the tag afterwards.
TAG="sha-${SHORT_SHA}"
REPOSITORY='agent-tool-server-azure'

log "Building ${REGISTRY_SERVER}/${REPOSITORY}:${TAG} in ACR"
# Logs are deliberately not streamed. The CLI pipes them through colorama, which crashes on any
# console whose code page cannot encode the build output — aborting a release whose cloud build is
# perfectly fine. They are fetched explicitly below if the build actually fails.
if ! az acr build \
  --registry "${REGISTRY_NAME}" \
  --image "${REPOSITORY}:${TAG}" \
  --build-arg "GIT_SHA=${GIT_SHA}" \
  --build-arg "SERVICE_VERSION=${VERSION}" \
  --file "${REPO_ROOT}/Dockerfile" \
  "${REPO_ROOT}" \
  --no-logs \
  --output none; then
  FAILED_RUN="$(az acr task list-runs --registry "${REGISTRY_NAME}" --top 1 \
    --query '[0].runId' --output tsv 2>/dev/null || true)"
  if [[ -n "${FAILED_RUN}" ]]; then
    warn "The ACR build failed. Logs for run ${FAILED_RUN}:"
    az acr task logs --registry "${REGISTRY_NAME}" --run-id "${FAILED_RUN}" || true
  fi
  die "Image build failed."
fi

DIGEST="$(az acr repository show \
  --name "${REGISTRY_NAME}" \
  --image "${REPOSITORY}:${TAG}" \
  --query digest --output tsv)"
[[ -n "${DIGEST}" ]] || die "Could not resolve the digest of the image that was just built."
IMAGE="${REGISTRY_SERVER}/${REPOSITORY}@${DIGEST}"
log "Releasing ${IMAGE}"

APP_NAME="ca-agent-tool-server-${ENVIRONMENT}"
FQDN="$(az containerapp show --name "${APP_NAME}" --resource-group "${RESOURCE_GROUP}" \
  --query properties.configuration.ingress.fqdn --output tsv)"
[[ -n "${FQDN}" ]] || die "Container app ${APP_NAME} not found. Run provision.sh first."

DEPLOYMENT_NAME="atsa-${ENVIRONMENT}-release-$(date -u +%Y%m%d%H%M%S)"
RELEASE_ARGS=(
  --parameters "@${PARAMETERS}"
  --parameters
  image="${IMAGE}"
  gitSha="${GIT_SHA}"
  serviceVersion="${VERSION}"
  publicBaseUrl="https://${FQDN}"
)

review_changes "${DEPLOYMENT_NAME}" "${LOCATION}" "${RELEASE_ARGS[@]}"
confirm "Release ${VERSION} (${SHORT_SHA}) to '${ENVIRONMENT}'?"

az deployment sub create \
  --name "${DEPLOYMENT_NAME}" \
  --location "${LOCATION}" \
  --template-file "${REPO_ROOT}/infra/main.bicep" \
  "${RELEASE_ARGS[@]}" \
  --output none

log "Verifying the release"
for _ in $(seq 1 30); do
  if curl -fsS "https://${FQDN}/health" >/dev/null; then break; fi
  sleep 2
done
curl -fsS "https://${FQDN}/health" >/dev/null || die "The server did not become healthy."

READY="$(curl -fsS "https://${FQDN}/ready" || true)"
if [[ -z "${READY}" ]] || [[ "$(printf '%s' "${READY}" | jq -r '.ready')" != "true" ]]; then
  warn "The server is alive but not ready:"
  printf '%s\n' "${READY}" | jq '.components' >&2 || true
  die "Release verification failed."
fi

RUNNING_SHA="$(curl -fsS "https://${FQDN}/version" | jq -r '.gitSha')"
[[ "${RUNNING_SHA}" == "${GIT_SHA}" ]] ||
  warn "The running revision reports git SHA ${RUNNING_SHA}, not ${GIT_SHA}. Traffic may still be shifting."

cat <<SUMMARY

==> Released

  Version        ${VERSION}
  Git SHA        ${GIT_SHA}
  Image          ${IMAGE}
  Server URL     https://${FQDN}
  OpenAPI        https://${FQDN}/openapi.json
  Remote MCP     https://${FQDN}/mcp
  Readiness      https://${FQDN}/ready
SUMMARY
