#!/usr/bin/env bash
#
# Shared helpers for the bootstrap and release scripts.
#
# The single most important rule here: the per-environment parameter file under infra/parameters is
# the authority for what an environment is configured to be. Every deployment passes that file, so a
# release can never quietly reset a setting to a Bicep default just because the command line did not
# mention it.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly REPO_ROOT

log() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "${tool}" >/dev/null 2>&1 || die "${tool} is required but was not found on PATH"
  done
}

parameter_file() {
  local environment="$1"
  local path="${REPO_ROOT}/infra/parameters/${environment}.parameters.json"
  [[ -f "${path}" ]] || die "No parameter file for environment '${environment}'. Expected ${path}"
  printf '%s' "${path}"
}

# Reads one value out of the authoritative parameter file.
parameter_value() {
  local environment="$1" name="$2" fallback="${3-}"
  local value
  value="$(jq -r --arg name "${name}" '.parameters[$name].value // empty' \
    "$(parameter_file "${environment}")")"
  printf '%s' "${value:-${fallback}}"
}

# Fails fast when the shell is pointed at a different subscription or tenant than intended.
# Deploying into the wrong subscription is the one mistake these scripts cannot undo for you.
preflight() {
  local subscription_id="$1" environment="$2"

  az account show >/dev/null 2>&1 || die "Not signed in. Run 'az login' first."
  az account set --subscription "${subscription_id}"

  local actual_id actual_name tenant_id user
  actual_id="$(az account show --query id --output tsv)"
  actual_name="$(az account show --query name --output tsv)"
  tenant_id="$(az account show --query tenantId --output tsv)"
  user="$(az account show --query user.name --output tsv)"

  [[ "${actual_id}" == "${subscription_id}" ]] ||
    die "Requested subscription ${subscription_id} but the CLI resolved ${actual_id}"

  cat <<PREFLIGHT
==> Preflight
  Environment      ${environment}
  Subscription     ${actual_name} (${actual_id})
  Tenant           ${tenant_id}
  Signed in as     ${user}
  Parameter file   $(parameter_file "${environment}")
PREFLIGHT
}

confirm() {
  local prompt="$1"
  if [[ "${ASSUME_YES:-false}" == "true" ]]; then
    log "${prompt} (auto-confirmed by ASSUME_YES)"
    return 0
  fi
  local reply
  read -r -p "${prompt} [y/N] " reply
  [[ "${reply}" == "y" || "${reply}" == "Y" ]] || die "Aborted."
}

# Validates the template, then runs what-if, prints the plan, and refuses to continue silently when
# resources would be deleted.
review_changes() {
  local deployment_name="$1" location="$2"
  shift 2

  log "Validating the template"
  az deployment sub validate \
    --name "${deployment_name}-validate" \
    --location "${location}" \
    --template-file "${REPO_ROOT}/infra/main.bicep" \
    "$@" \
    --output none

  log "Previewing changes (what-if)"
  local plan
  plan="$(az deployment sub what-if \
    --name "${deployment_name}" \
    --location "${location}" \
    --template-file "${REPO_ROOT}/infra/main.bicep" \
    "$@" \
    --no-pretty-print)"

  printf '%s' "${plan}" |
    jq -r '(.changes // []) | group_by(.changeType) | map("  \(.[0].changeType): \(length)") | .[]'

  local deletes
  deletes="$(printf '%s' "${plan}" |
    jq -r '[.changes[]? | select(.changeType == "Delete")] | .[].resourceId')"

  if [[ -n "${deletes}" ]]; then
    warn "This deployment DELETES the following resources:"
    printf '%s\n' "${deletes}" | sed 's/^/  /' >&2
    confirm "Proceed with a deployment that deletes resources?"
  fi
}
