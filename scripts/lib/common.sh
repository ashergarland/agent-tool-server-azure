#!/usr/bin/env bash
#
# Shared helpers for the bootstrap and release scripts.
#
# The operator-supplied parameter file is the authority for a deployment. Every deployment passes the
# explicit path unchanged, so the public repository never chooses an environment and a release cannot
# quietly reset a setting merely because the command line did not mention it.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Git Bash and Cygwin hand POSIX paths like /c/Users/... to bash, but the Azure CLI is a native
# Windows program that reads those as C:\c\Users\... Convert once, here, into a mixed form
# (C:/Users/...) that both bash builtins and native programs understand. On Linux and macOS there is
# no cygpath and the path is already correct, so this is a no-op.
if command -v cygpath >/dev/null 2>&1; then
  REPO_ROOT="$(cygpath -m "${REPO_ROOT}")"
fi
readonly REPO_ROOT

# The same translation layer rewrites any argument that looks like an absolute POSIX path, which
# corrupts ARM resource ids such as /subscriptions/<id>/... Prefix an az call that takes one of
# those with this to turn the rewriting off for that call only. Empty, and therefore harmless,
# everywhere else.
if [[ -n "${MSYSTEM:-}" ]] || command -v cygpath >/dev/null 2>&1; then
  ARM_ID_SAFE=(env MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*')
else
  ARM_ID_SAFE=()
fi
# shellcheck disable=SC2034  # consumed by the scripts that source this file, not by this file
readonly ARM_ID_SAFE

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
  local supplied_path="${1-}"
  [[ -n "${supplied_path}" ]] || die "An explicit operator parameter-file path is required."
  [[ -f "${supplied_path}" ]] || die "Parameter file not found: ${supplied_path}"

  local directory path
  directory="$(cd "$(dirname "${supplied_path}")" && pwd)"
  path="${directory}/$(basename "${supplied_path}")"
  if command -v cygpath >/dev/null 2>&1; then
    path="$(cygpath -m "${path}")"
  fi
  printf '%s' "${path}"
}

# Reads a required non-empty string out of the operator's parameter file.
required_parameter_value() {
  local path="$1" name="$2"
  local value
  if ! value="$(jq -er --arg name "${name}" \
    '.parameters[$name].value | select(type == "string" and length > 0)' "${path}")"; then
    die "Parameter file ${path} must define a non-empty string at .parameters.${name}.value"
  fi
  printf '%s' "${value}"
}

# Reads an optional non-empty string, falling back only when the parameter is absent.
parameter_value_or_default() {
  local path="$1" name="$2" fallback="$3"
  local has_parameter
  if ! has_parameter="$(jq -r --arg name "${name}" \
    'if (.parameters | type) != "object" then error("missing parameters object") else (.parameters | has($name)) end' \
    "${path}")"; then
    die "Parameter file ${path} must contain a parameters object."
  fi

  if [[ "${has_parameter}" == "true" ]]; then
    required_parameter_value "${path}" "${name}"
  else
    printf '%s' "${fallback}"
  fi
}

# Fails fast when the shell is pointed at a different subscription or tenant than intended.
# Deploying into the wrong subscription is the one mistake these scripts cannot undo for you.
preflight() {
  local subscription_id="$1" environment="$2" parameters="$3"

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
  Parameter file   ${parameters}
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
