targetScope = 'subscription'

metadata description = '''
Deploys agent-tool-server-azure: two user-assigned managed identities (one for reads and guarded
operations, one used only for deployments), a container registry, a Key Vault holding the API key
callers present, a Log Analytics workspace, optional record storage, custom least-privilege roles,
and the Container App that runs the image.

Nothing here is account specific. Every scope, identity, limit and toggle is a parameter, and the
per-environment parameter files under infra/parameters are the single authority for what a given
environment is configured to be.
'''

@description('Short environment name used to derive resource names, e.g. prod or dev.')
@minLength(2)
@maxLength(10)
param environmentName string = 'prod'

@description('Azure region for all server resources.')
param location string = deployment().location

@description('Resource group that will hold the server resources.')
param resourceGroupName string = 'rg-agent-tool-server-azure-${environmentName}'

@description('Container image to run. Prefer an immutable digest reference for releases.')
param image string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Git commit the image was built from.')
param gitSha string = 'unknown'

@description('Service version reported by /version.')
param serviceVersion string = '0.0.0'

@description('Public HTTPS base URL the server is reachable on. Set after the first deployment so the OpenAPI document advertises the right server.')
param publicBaseUrl string = ''

@description('Subscriptions the server may inspect. Defaults to the deployment subscription.')
param allowedSubscriptionIds array = [subscription().subscriptionId]

@description('Resource groups the server may touch. Empty means every group in the allowed subscriptions.')
param allowedResourceGroups array = []

@description('Management groups the server may deploy into. Empty disables management group scope.')
param allowedManagementGroupIds array = []

@description('Allow tenant scope deployments. Keep false unless you genuinely deploy at tenant scope.')
param tenantDeploymentsEnabled bool = false

@description('Report a subscription as usable only after asking ARM what the identities can do there.')
param verifyRbac bool = true

@description('Grant the operator role and enable the four guarded state-changing tools.')
param enableMutations bool = false

@description('Require explicit user confirmation for state-changing tools.')
param mutationConfirmationRequired bool = true

@description('Expose the authenticated remote MCP endpoint at /mcp.')
param enableMcpHttp bool = true

@description('''
Enable generic Bicep validate, what-if, deploy, status and rollback.

This creates a second managed identity, a record storage account, and a deployment runner role that
grants only the right to create deployments. It deliberately does not grant permission to create the
resources a template declares: assign those roles yourself, per resource type, at the narrowest
scope that works.
''')
param enableDeployments bool = false

@description('Absolute path of the Bicep CLI inside the image.')
param bicepCliPath string = '/usr/local/bin/bicep'

@description('Expected SHA-256 of that Bicep CLI. Required when deployments are enabled.')
param bicepCliSha256 string = ''

@description('Allow remote Bicep module restore. Read the threat model before enabling.')
param bicepRemoteModulesEnabled bool = false

@description('OCI registry hosts remote modules may be pulled from (comma separated).')
param bicepAllowedRegistries string = ''

@description('Wall-clock limit for one Bicep compilation, in milliseconds.')
param bicepCompileTimeoutMs int = 60000

@description('Maximum number of concurrent Bicep compilations per replica.')
@minValue(1)
param bicepMaxConcurrency int = 2

@description('Maximum number of files in a caller-supplied bundle.')
@minValue(1)
param bicepMaxFiles int = 64

@description('Maximum bytes for any single bundle file.')
@minValue(1024)
param bicepMaxFileBytes int = 262144

@description('Maximum total bytes across a bundle.')
@minValue(1024)
param bicepMaxTotalBytes int = 1048576

@description('How long a what-if preview stays valid, in milliseconds.')
param deploymentPreviewTtlMs int = 900000

@description('Maximum number of what-if changes returned to a caller.')
@minValue(1)
param deploymentMaxPreviewChanges int = 200

@description('Maximum number of concurrent deployments per replica.')
@minValue(1)
param deploymentMaxConcurrent int = 2

@description('Maximum accepted request body size, in bytes.')
@minValue(64000)
param maxBodyBytes int = 4194304

@description('Per-principal request budget inside the rate limit window.')
@minValue(0)
param rateLimitMax int = 120

@description('Rate limit window, in milliseconds.')
@minValue(1000)
param rateLimitWindowMs int = 60000

@description('Per-request timeout, in milliseconds.')
param requestTimeoutMs int = 30000

@description('How long to drain in-flight requests on SIGTERM, in milliseconds.')
param shutdownGraceMs int = 10000

@description('CPU cores per replica, as a string, e.g. "0.5".')
param cpu string = '0.5'

@description('Memory per replica, e.g. "1Gi".')
param memory string = '1Gi'

@description('Minimum replicas. Zero keeps an idle deployment nearly free.')
@minValue(0)
param minReplicas int = 0

@description('Maximum replicas.')
@minValue(1)
param maxReplicas int = 3

@description('Concurrent requests per replica before Container Apps scales out.')
@minValue(1)
param httpConcurrentRequests int = 20

@description('Log level for the server.')
@allowed(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
param logLevel string = 'info'

@description('Additional tags applied to every resource.')
param tags object = {}

@description('''
Deploy the Container App. The app mounts the API key from Key Vault, so the very first provisioning
pass must run with this set to false: it creates the vault and the identities, the bootstrap script
writes the secret, and the second pass brings the app up.
''')
param deployApp bool = true

@description('Deploy an availability test and alert that notify when the server stops answering /health. Requires alertEmails or alertSmsPhone.')
param enableHealthAlerts bool = false

@description('Email addresses notified when the server goes down. Supply at deployment time; do not commit personal addresses to a parameter file.')
param alertEmails array = []

@description('Phone number notified by SMS when the server goes down, digits only.')
param alertSmsPhone string = ''

@description('Country code for the SMS number, e.g. 1 for the United States.')
param alertSmsCountryCode string = '1'

// Built-in read roles. Everything the server writes goes through a custom role instead.
// Reader: read-only access to every resource in scope.
var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
// Monitoring Reader: activity log and metrics.
var monitoringReaderRoleId = '43d0d8ad-25c7-4714-9337-8ba259a9fe05'
var readRoles = [readerRoleId, monitoringReaderRoleId]

var suffix = uniqueString(subscription().id, resourceGroupName)
var defaultTags = union(tags, {
  workload: 'agent-tool-server-azure'
  environment: environmentName
  managedBy: 'bicep'
})

resource serverResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: defaultTags
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  scope: serverResourceGroup
  params: {
    name: 'id-agent-tool-server-azure-${environmentName}'
    location: location
    tags: defaultTags
  }
}

// A second identity exists only when deployments are enabled. Keeping the broad write permissions a
// deployment needs on a principal the read and operator surface never uses is the whole point.
module deploymentIdentity 'modules/identity.bicep' = if (enableDeployments) {
  name: 'deployment-identity'
  scope: serverResourceGroup
  params: {
    name: 'id-agent-tool-server-azure-deploy-${environmentName}'
    location: location
    tags: defaultTags
  }
}

module registry 'modules/container-registry.bicep' = {
  name: 'registry'
  scope: serverResourceGroup
  params: {
    name: 'acragenttoolserverazure${suffix}'
    location: location
    tags: defaultTags
    pullPrincipalId: identity.outputs.principalId
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: 'key-vault'
  scope: serverResourceGroup
  params: {
    name: 'kv-atsa-${suffix}'
    location: location
    tags: defaultTags
    readerPrincipalId: identity.outputs.principalId
  }
}

module logAnalytics 'modules/log-analytics.bicep' = {
  name: 'log-analytics'
  scope: serverResourceGroup
  params: {
    name: 'log-agent-tool-server-azure-${environmentName}'
    location: location
    tags: defaultTags
  }
}

module recordStorage 'modules/record-storage.bicep' = if (enableDeployments) {
  name: 'record-storage'
  scope: serverResourceGroup
  params: {
    name: 'statsa${suffix}'
    location: location
    tags: defaultTags
    deploymentPrincipalId: deploymentIdentity!.outputs.principalId
  }
}

module customRoles 'modules/custom-roles.bicep' = {
  name: 'custom-roles'
  params: {
    namePrefix: 'agent-tool-server-azure-${environmentName}'
    includeDeploymentRunner: enableDeployments
  }
}

module rbac 'modules/rbac.bicep' = {
  name: 'rbac'
  params: {
    operatorPrincipalId: identity.outputs.principalId
    deploymentPrincipalId: enableDeployments ? deploymentIdentity!.outputs.principalId : ''
    readRoleDefinitionIds: readRoles
    operatorRoleDefinitionId: enableMutations ? customRoles.outputs.operatorRoleDefinitionId : ''
    deploymentRoleDefinitionId: enableDeployments
      ? customRoles.outputs.deploymentRunnerRoleDefinitionId
      : ''
    resourceGroupNames: allowedResourceGroups
  }
}

module containerApp 'modules/container-app.bicep' = if (deployApp) {
  name: 'container-app'
  scope: serverResourceGroup
  params: {
    environmentName: 'cae-agent-tool-server-${environmentName}'
    appName: 'ca-agent-tool-server-${environmentName}'
    location: location
    tags: defaultTags
    logAnalyticsWorkspaceId: logAnalytics.outputs.id
    identityId: identity.outputs.id
    identityClientId: identity.outputs.clientId
    deploymentIdentityId: enableDeployments ? deploymentIdentity!.outputs.id : ''
    deploymentIdentityClientId: enableDeployments ? deploymentIdentity!.outputs.clientId : ''
    image: image
    gitSha: gitSha
    serviceVersion: serviceVersion
    registryLoginServer: registry.outputs.loginServer
    apiKeySecretUri: '${keyVault.outputs.uri}secrets/connector-api-key'
    publicBaseUrl: publicBaseUrl
    allowedSubscriptionIds: join(allowedSubscriptionIds, ',')
    allowedResourceGroups: join(allowedResourceGroups, ',')
    allowedManagementGroupIds: join(allowedManagementGroupIds, ',')
    tenantDeploymentsEnabled: tenantDeploymentsEnabled
    verifyRbac: verifyRbac
    mutationsEnabled: enableMutations
    mutationConfirmationRequired: mutationConfirmationRequired
    mcpHttpEnabled: enableMcpHttp
    deploymentsEnabled: enableDeployments
    bicepCliPath: bicepCliPath
    bicepCliSha256: bicepCliSha256
    bicepCompileTimeoutMs: bicepCompileTimeoutMs
    bicepMaxConcurrency: bicepMaxConcurrency
    bicepMaxFiles: bicepMaxFiles
    bicepMaxFileBytes: bicepMaxFileBytes
    bicepMaxTotalBytes: bicepMaxTotalBytes
    bicepRemoteModulesEnabled: bicepRemoteModulesEnabled
    bicepAllowedRegistries: bicepAllowedRegistries
    deploymentPreviewTtlMs: deploymentPreviewTtlMs
    deploymentMaxPreviewChanges: deploymentMaxPreviewChanges
    deploymentMaxConcurrent: deploymentMaxConcurrent
    deploymentRecordStore: enableDeployments ? 'azure-table' : 'memory'
    deploymentRecordTableEndpoint: enableDeployments ? recordStorage!.outputs.tableEndpoint : ''
    deploymentRecordTableName: enableDeployments
      ? recordStorage!.outputs.recordsTableName
      : 'deploymentrecords'
    deploymentLockTableName: enableDeployments
      ? recordStorage!.outputs.locksTableName
      : 'deploymentlocks'
    maxBodyBytes: maxBodyBytes
    rateLimitMax: rateLimitMax
    rateLimitWindowMs: rateLimitWindowMs
    requestTimeoutMs: requestTimeoutMs
    shutdownGraceMs: shutdownGraceMs
    cpu: cpu
    memory: memory
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    httpConcurrentRequests: httpConcurrentRequests
    logLevel: logLevel
  }
}

// Availability monitoring is opt-in: it only makes sense once the app exists and an owner has said
// where to send alerts. Deploying it with no receivers would create an alert that fires into
// nothing, which is worse than no alert because it looks like coverage.
module monitoring 'modules/monitoring.bicep' = if (deployApp && enableHealthAlerts) {
  name: 'monitoring'
  scope: serverResourceGroup
  params: {
    name: 'agent-tool-server-azure-${environmentName}'
    location: location
    tags: defaultTags
    connectorUrl: 'https://${containerApp!.outputs.fqdn}'
    logAnalyticsWorkspaceId: logAnalytics.outputs.id
    alertEmails: alertEmails
    alertSmsPhone: alertSmsPhone
    alertSmsCountryCode: alertSmsCountryCode
  }
}

output resourceGroupName string = serverResourceGroup.name
output identityClientId string = identity.outputs.clientId
output identityPrincipalId string = identity.outputs.principalId
output deploymentIdentityClientId string = enableDeployments
  ? deploymentIdentity!.outputs.clientId
  : ''
output deploymentIdentityPrincipalId string = enableDeployments
  ? deploymentIdentity!.outputs.principalId
  : ''
output operatorRoleDefinitionId string = customRoles.outputs.operatorRoleDefinitionId
output deploymentRunnerRoleDefinitionId string = customRoles.outputs.deploymentRunnerRoleDefinitionId
output registryLoginServer string = registry.outputs.loginServer
output keyVaultName string = keyVault.outputs.name
output recordTableEndpoint string = enableDeployments ? recordStorage!.outputs.tableEndpoint : ''
output serverUrl string = deployApp ? 'https://${containerApp!.outputs.fqdn}' : ''
output openApiUrl string = deployApp ? 'https://${containerApp!.outputs.fqdn}/openapi.json' : ''
output mcpUrl string = deployApp && enableMcpHttp ? 'https://${containerApp!.outputs.fqdn}/mcp' : ''
