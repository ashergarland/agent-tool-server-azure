targetScope = 'subscription'

metadata description = '''
Deploys the Azure agent tool server: a user-assigned managed identity, a container registry,
a Key Vault holding the connector API key, a Log Analytics workspace, and a Container App that
runs the connector image. The identity is granted read-only Azure RBAC by default; operator
roles are only assigned when `enableMutations` is true.
'''

@description('Short environment name used to derive resource names, e.g. prod or dev.')
@minLength(2)
@maxLength(10)
param environmentName string = 'prod'

@description('Azure region for all connector resources.')
param location string = deployment().location

@description('Resource group that will hold the connector resources.')
param resourceGroupName string = 'rg-chatgpt-azure-${environmentName}'

@description('Container image to run. Leave as the default placeholder for the first deployment, then redeploy with the real tag.')
param image string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Public HTTPS base URL the connector is reachable on. Set after the first deployment so the OpenAPI document advertises the right server.')
param publicBaseUrl string = ''

@description('Subscriptions the connector may inspect. Defaults to the deployment subscription.')
param allowedSubscriptionIds array = [subscription().subscriptionId]

@description('Resource groups the connector may touch. Empty means every group in the allowed subscriptions.')
param allowedResourceGroups array = []

@description('Grant the connector the operator roles and enable state-changing tools.')
param enableMutations bool = false

@description('Require explicit user confirmation for state-changing tools.')
param mutationConfirmationRequired bool = true

@description('Log level for the connector.')
@allowed(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
param logLevel string = 'info'

@description('Additional tags applied to every resource.')
param tags object = {}

@description('''
Deploy the Container App. The app mounts the connector API key from Key Vault, so the very first
provisioning pass must run with this set to false: it creates the vault and the identity, the
bootstrap script writes the secret, and the second pass brings the app up.
''')
param deployApp bool = true

@description('Deploy an availability test and alert that notify when the connector stops answering /health. Requires alertEmails or alertSmsPhone to be set, otherwise the alert would have nowhere to fire.')
param enableHealthAlerts bool = false

@description('Email addresses notified when the connector goes down. Supply at deployment time; do not commit personal addresses to a parameter file.')
param alertEmails array = []

@description('Phone number notified by SMS when the connector goes down, digits only.')
param alertSmsPhone string = ''

@description('Country code for the SMS number, e.g. 1 for the United States.')
param alertSmsCountryCode string = '1'

// Built-in role definition ids.
// Reader: read-only access to every resource in scope.
var readerRoleId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
// Monitoring Reader: activity log and metrics.
var monitoringReaderRoleId = '43d0d8ad-25c7-4714-9337-8ba259a9fe05'
// Virtual Machine Contributor: restart/start virtual machines.
var vmContributorRoleId = '9980e02c-c2be-4d73-94e8-173b1dc7cf3c'
// Website Contributor: restart App Service sites.
var websiteContributorRoleId = 'de139f84-1756-47ae-9be6-808fbbe84772'
// Tag Contributor: manage resource tags.
var tagContributorRoleId = '4a9ae827-6dc8-4573-8ac7-8239d42aa03f'

var readRoles = [readerRoleId, monitoringReaderRoleId]
var writeRoles = [vmContributorRoleId, websiteContributorRoleId, tagContributorRoleId]
var assignedRoles = enableMutations ? concat(readRoles, writeRoles) : readRoles

var suffix = uniqueString(subscription().id, resourceGroupName)
var defaultTags = union(tags, {
  workload: 'agent-tool-server-azure'
  environment: environmentName
  managedBy: 'bicep'
})

resource connectorResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: defaultTags
}

module identity 'modules/identity.bicep' = {
  name: 'identity'
  scope: connectorResourceGroup
  params: {
    name: 'id-chatgpt-azure-${environmentName}'
    location: location
    tags: defaultTags
  }
}

module registry 'modules/container-registry.bicep' = {
  name: 'registry'
  scope: connectorResourceGroup
  params: {
    name: 'acrchatgptazure${suffix}'
    location: location
    tags: defaultTags
    pullPrincipalId: identity.outputs.principalId
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: 'key-vault'
  scope: connectorResourceGroup
  params: {
    name: 'kv-cgaz-${suffix}'
    location: location
    tags: defaultTags
    readerPrincipalId: identity.outputs.principalId
  }
}

module logAnalytics 'modules/log-analytics.bicep' = {
  name: 'log-analytics'
  scope: connectorResourceGroup
  params: {
    name: 'log-chatgpt-azure-${environmentName}'
    location: location
    tags: defaultTags
  }
}

module rbac 'modules/rbac.bicep' = {
  name: 'rbac'
  params: {
    principalId: identity.outputs.principalId
    roleDefinitionIds: assignedRoles
    resourceGroupNames: allowedResourceGroups
  }
}

module containerApp 'modules/container-app.bicep' = if (deployApp) {
  name: 'container-app'
  scope: connectorResourceGroup
  params: {
    environmentName: 'cae-chatgpt-azure-${environmentName}'
    appName: 'ca-chatgpt-azure-${environmentName}'
    location: location
    tags: defaultTags
    logAnalyticsWorkspaceId: logAnalytics.outputs.id
    identityId: identity.outputs.id
    identityClientId: identity.outputs.clientId
    image: image
    registryLoginServer: registry.outputs.loginServer
    apiKeySecretUri: '${keyVault.outputs.uri}secrets/connector-api-key'
    publicBaseUrl: publicBaseUrl
    allowedSubscriptionIds: join(allowedSubscriptionIds, ',')
    allowedResourceGroups: join(allowedResourceGroups, ',')
    mutationsEnabled: enableMutations
    mutationConfirmationRequired: mutationConfirmationRequired
    logLevel: logLevel
  }
}

// Availability monitoring is opt-in: it only makes sense once the app exists and an owner has
// said where to send alerts. Deploying it with no receivers would create an alert that fires
// into nothing, which is worse than no alert because it looks like coverage.
module monitoring 'modules/monitoring.bicep' = if (deployApp && enableHealthAlerts) {
  name: 'monitoring'
  scope: connectorResourceGroup
  params: {
    name: 'chatgpt-azure-${environmentName}'
    location: location
    tags: defaultTags
    connectorUrl: 'https://${containerApp!.outputs.fqdn}'
    logAnalyticsWorkspaceId: logAnalytics.outputs.id
    alertEmails: alertEmails
    alertSmsPhone: alertSmsPhone
    alertSmsCountryCode: alertSmsCountryCode
  }
}

output resourceGroupName string = connectorResourceGroup.name
output identityClientId string = identity.outputs.clientId
output identityPrincipalId string = identity.outputs.principalId
output registryLoginServer string = registry.outputs.loginServer
output keyVaultName string = keyVault.outputs.name
output connectorUrl string = deployApp ? 'https://${containerApp!.outputs.fqdn}' : ''
output openApiUrl string = deployApp ? 'https://${containerApp!.outputs.fqdn}/openapi.json' : ''
