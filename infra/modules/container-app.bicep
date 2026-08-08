@description('Name of the Container Apps environment.')
param environmentName string

@description('Name of the connector container app.')
param appName string

@description('Azure region.')
param location string

@description('Tags applied to all resources in this module.')
param tags object = {}

@description('Resource id of the Log Analytics workspace for container logs.')
param logAnalyticsWorkspaceId string

@description('Resource id of the user-assigned managed identity.')
param identityId string

@description('Client id of the user-assigned managed identity, passed to the Azure SDK.')
param identityClientId string

@description('Fully qualified container image reference.')
param image string

@description('Login server of the container registry the image is pulled from.')
param registryLoginServer string

@description('Key Vault secret URI holding the connector API key.')
param apiKeySecretUri string

@description('Public base URL advertised in the generated OpenAPI document.')
param publicBaseUrl string = ''

@description('Subscription ids the connector is allowed to touch (comma separated).')
param allowedSubscriptionIds string = ''

@description('Resource groups the connector is allowed to touch (comma separated).')
param allowedResourceGroups string = ''

@description('Enable state-changing tools.')
param mutationsEnabled bool = false

@description('Require explicit confirmation for state-changing tools.')
param mutationConfirmationRequired bool = true

@description('Log level for the connector.')
@allowed(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
param logLevel string = 'info'

@description('Minimum number of replicas. Zero lets the app scale to nothing when idle, which is what makes a low-traffic connector nearly free to run: Container Apps bills per second of running replica, so a permanently warm replica costs money around the clock whether or not anyone calls it. The trade is a cold start of a few seconds on the first request after an idle period.')
@minValue(0)
param minReplicas int = 0

@description('Maximum number of replicas.')
@minValue(1)
param maxReplicas int = 3

// Optional settings are omitted entirely rather than declared as empty strings. An absent
// PUBLIC_BASE_URL means "not configured", not "configured to nothing", and the connector
// validates its environment strictly at startup — an empty string fails `z.url()` and the
// container exits. The app deployment that first creates the ingress has no hostname to supply.
var optionalEnv = empty(publicBaseUrl) ? [] : [{ name: 'PUBLIC_BASE_URL', value: publicBaseUrl }]

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: last(split(logAnalyticsWorkspaceId, '/'))
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    zoneRedundant: false
  }
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: registryLoginServer
          identity: identityId
        }
      ]
      secrets: [
        {
          name: 'connector-api-key'
          keyVaultUrl: apiKeySecretUri
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'connector'
          image: image
          resources: {
            // Smallest supported CPU/memory pair. The connector is I/O bound - it waits on Azure
            // Resource Manager rather than computing - so cutting the allocation halves the
            // per-second cost without changing how fast a request returns.
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: concat(
            [
              { name: 'NODE_ENV', value: 'production' }
              { name: 'PORT', value: '8080' }
              { name: 'LOG_LEVEL', value: logLevel }
              { name: 'SERVICE_NAME', value: appName }
              { name: 'AUTH_MODE', value: 'api-key' }
              { name: 'API_KEYS', secretRef: 'connector-api-key' }
              { name: 'AZURE_CLIENT_ID', value: identityClientId }
              { name: 'AZURE_SUBSCRIPTION_IDS', value: allowedSubscriptionIds }
              { name: 'AZURE_ALLOWED_RESOURCE_GROUPS', value: allowedResourceGroups }
              { name: 'MUTATIONS_ENABLED', value: toLower(string(mutationsEnabled)) }
              {
                name: 'MUTATION_CONFIRMATION_REQUIRED'
                value: toLower(string(mutationConfirmationRequired))
              }
            ],
            optionalEnv
          )
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: 8080
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-scale'
            http: {
              metadata: {
                concurrentRequests: '20'
              }
            }
          }
        ]
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output appName string = app.name
output environmentId string = environment.id
