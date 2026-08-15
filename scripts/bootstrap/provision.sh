#!/usr/bin/env bash
#
# Provisions the agent-tool-server-azure infrastructure for one environment and stores a freshly
# generated API key in Key Vault.
#
# Usage:
#   ./scripts/bootstrap/provision.sh <subscription-id> <environment> <location>
#
# The environment must have a parameter file at infra/parameters/<environment>.parameters.json.
# That file is the authority for the environment's configuration; this script never invents values.
#
# Requires: az CLI (signed in), jq, openssl.

set -euo pipefail

# shellcheck source=../lib/common.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/common.sh"

SUBSCRIPTION_ID="${1:?usage: provision.sh <subscription-id> <environment> <location>}"
ENVIRONMENT="${2:?usage: provision.sh <subscription-id> <environment> <location>}"
LOCATION="${3:?usage: provision.sh <subscription-id> <environment> <location>}"

require_tools az jq openssl
PARAMETERS="$(parameter_file "${ENVIRONMENT}")"
preflight "${SUBSCRIPTION_ID}" "${ENVIRONMENT}"
confirm "Provision the '${ENVIRONMENT}' environment in ${LOCATION}?"

STAMP="$(date -u +%Y%m%d%H%M%S)"

# The Container App mounts the API key straight out of Key Vault, so it cannot be created until that
# secret exists. Pass 1 stands up the vault and the identities, we write the secret, and pass 2
# brings the app up.
FOUNDATION_DEPLOYMENT="atsa-${ENVIRONMENT}-foundation-${STAMP}"
log "Deploying foundation: identities, registry, vault, logs, custom roles, RBAC"
review_changes "${FOUNDATION_DEPLOYMENT}" "${LOCATION}" \
  --parameters "@${PARAMETERS}" \
  --parameters deployApp=false

az deployment sub create \
  --name "${FOUNDATION_DEPLOYMENT}" \
  --location "${LOCATION}" \
  --template-file "${REPO_ROOT}/infra/main.bicep" \
  --parameters "@${PARAMETERS}" \
  --parameters deployApp=false \
  --output none

read_output() {
  az deployment sub show --name "${FOUNDATION_DEPLOYMENT}" \
    --query "properties.outputs.$1.value" --output tsv
}

RESOURCE_GROUP="$(read_output resourceGroupName)"
KEY_VAULT="$(read_output keyVaultName)"
REGISTRY="$(read_output registryLoginServer)"
IDENTITY_CLIENT_ID="$(read_output identityClientId)"
DEPLOY_IDENTITY_PRINCIPAL="$(read_output deploymentIdentityPrincipalId)"
DEPLOY_ROLE_ID="$(read_output deploymentRunnerRoleDefinitionId)"

# The vault uses RBAC authorisation, so subscription Owner alone does not grant data-plane access.
# Grant the operator the secrets role and wait for it to propagate.
CALLER_ID="$(az ad signed-in-user show --query id --output tsv)"
VAULT_ID="$(az keyvault show --name "${KEY_VAULT}" --resource-group "${RESOURCE_GROUP}" --query id --output tsv)"
if ! "${ARM_ID_SAFE[@]}" az role assignment list --assignee "${CALLER_ID}" --scope "${VAULT_ID}" \
  --query "[?roleDefinitionName=='Key Vault Secrets Officer'] | [0]" --output tsv | grep -q .; then
  log "Granting the current user Key Vault Secrets Officer on ${KEY_VAULT}"
  "${ARM_ID_SAFE[@]}" az role assignment create \
    --assignee-object-id "${CALLER_ID}" \
    --assignee-principal-type User \
    --role "Key Vault Secrets Officer" \
    --scope "${VAULT_ID}" \
    --output none
  log "Waiting for the role assignment to propagate"
  sleep 45
fi

log "Ensuring an API key exists in ${KEY_VAULT}"
if ! az keyvault secret show --vault-name "${KEY_VAULT}" --name connector-api-key --output none 2>/dev/null; then
  API_KEY="$(openssl rand -hex 32)"
  az keyvault secret set \
    --vault-name "${KEY_VAULT}" \
    --name connector-api-key \
    --value "${API_KEY}" \
    --output none
  unset API_KEY
  log "Generated a new API key. Retrieve it with:"
  printf '    az keyvault secret show --vault-name %s --name connector-api-key --query value -o tsv\n' "${KEY_VAULT}"
else
  log "Existing API key left untouched."
fi

# The app's ingress hostname is derived from the managed environment domain, which only exists after
# the app deployment. Deploy once to create it, then read the FQDN back; the release script keeps
# PUBLIC_BASE_URL correct from then on.
APP_DEPLOYMENT="atsa-${ENVIRONMENT}-app-${STAMP}"
log "Deploying the Container App"
az deployment sub create \
  --name "${APP_DEPLOYMENT}" \
  --location "${LOCATION}" \
  --template-file "${REPO_ROOT}/infra/main.bicep" \
  --parameters "@${PARAMETERS}" \
  --output none

SERVER_URL="$(az deployment sub show --name "${APP_DEPLOYMENT}" \
  --query "properties.outputs.serverUrl.value" --output tsv)"

cat <<SUMMARY

==> Bootstrap complete

  Resource group        ${RESOURCE_GROUP}
  Container registry    ${REGISTRY}
  Key Vault             ${KEY_VAULT}
  Operator identity     ${IDENTITY_CLIENT_ID}
  Server URL            ${SERVER_URL}

The app is running the placeholder image, and because the ingress hostname does not exist until the
app is created, PUBLIC_BASE_URL is not set yet: the OpenAPI document advertises localhost until you
run a release, which supplies the real hostname. Do not register the server with a client before
then.

Next steps:
  1. Build and release the real image:
       ./scripts/bootstrap/deploy.sh ${SUBSCRIPTION_ID} ${ENVIRONMENT} ${LOCATION}
  2. Point your client at ${SERVER_URL}/openapi.json (HTTP) or ${SERVER_URL}/mcp (remote MCP),
     using the API key from Key Vault as the bearer token.
SUMMARY

if [[ -n "${DEPLOY_IDENTITY_PRINCIPAL}" ]]; then
  cat <<DEPLOYMENTS

==> Generic Bicep deployment is enabled for this environment

The deployment identity (principal ${DEPLOY_IDENTITY_PRINCIPAL}) holds the deployment runner role
${DEPLOY_ROLE_ID}, which lets it create ARM deployments and read resources. It deliberately does NOT
let it create the resources a template declares.

Grant the write permissions you actually intend, per resource type, at the narrowest scope that
works, for example:

  az role assignment create \\
    --assignee-object-id ${DEPLOY_IDENTITY_PRINCIPAL} \\
    --assignee-principal-type ServicePrincipal \\
    --role "<a role covering only the resource types you intend to deploy>" \\
    --scope "/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/<target-resource-group>"

Templates that create role assignments additionally require a privileged role such as Role Based
Access Control Administrator. Do not grant Owner.
DEPLOYMENTS
fi
