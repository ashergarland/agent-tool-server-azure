metadata description = '''
The Container App that runs the tool server.

Every operational setting is a parameter with an explicit default, and the whole environment
contract is rendered from those parameters. Nothing here is derived from the caller's shell or from
a previous deployment, so redeploying with the same parameter file always produces the same app.
'''

@description('Name of the Container Apps environment.')
param environmentName string

@description('Name of the container app.')
param appName string

@description('Azure region.')
param location string

@description('Tags applied to all resources in this module.')
param tags object = {}

@description('Resource id of the Log Analytics workspace for container logs.')
param logAnalyticsWorkspaceId string

@description('Resource id of the read and operator user-assigned managed identity.')
param identityId string

@description('Client id of the read and operator identity, passed to the Azure SDK.')
param identityClientId string

@description('Resource id of the deployment identity. Empty when deployments are disabled.')
param deploymentIdentityId string = ''

@description('Client id of the deployment identity. Empty when deployments are disabled.')
param deploymentIdentityClientId string = ''

@description('Fully qualified container image reference. Prefer an immutable digest.')
param image string

@description('Login server of the container registry the image is pulled from.')
param registryLoginServer string

@description('Key Vault secret URI holding the API key callers present.')
param apiKeySecretUri string

@description('Public base URL advertised in the generated OpenAPI document.')
param publicBaseUrl string = ''

@description('Git commit the image was built from. Reported by /version.')
param gitSha string = 'unknown'

@description('Service version reported by /version and the OpenAPI document.')
param serviceVersion string = '0.0.0'

@description('Subscription ids the server is allowed to touch (comma separated).')
param allowedSubscriptionIds string = ''

@description('Resource groups the server is allowed to touch (comma separated).')
param allowedResourceGroups string = ''

@description('Management group ids the server may deploy into (comma separated).')
param allowedManagementGroupIds string = ''

@description('Allow tenant scope deployments. Off unless deliberately enabled.')
param tenantDeploymentsEnabled bool = false

@description('Ask ARM what each identity can actually do before reporting a scope as usable.')
param verifyRbac bool = true

@description('Enable the four guarded state-changing tools.')
param mutationsEnabled bool = false

@description('Require explicit confirmation for state-changing tools.')
param mutationConfirmationRequired bool = true

@description('Enable the authenticated remote MCP endpoint at /mcp.')
param mcpHttpEnabled bool = true

@description('Enable generic Bicep validate, what-if, deploy, status and rollback.')
param deploymentsEnabled bool = false

@description('Absolute path of the Bicep CLI inside the image.')
param bicepCliPath string = '/usr/local/bin/bicep'

@description('Expected SHA-256 of that Bicep CLI. Required when deployments are enabled in production.')
param bicepCliSha256 string = ''

@description('Wall-clock limit for one Bicep compilation, in milliseconds.')
param bicepCompileTimeoutMs int = 60000

@description('Maximum number of concurrent Bicep compilations.')
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

@description('Allow remote Bicep module restore. Off by default; see the threat model before enabling.')
param bicepRemoteModulesEnabled bool = false

@description('OCI registry hosts remote modules may be pulled from (comma separated).')
param bicepAllowedRegistries string = ''

@description('How long a what-if preview stays valid, in milliseconds.')
param deploymentPreviewTtlMs int = 900000

@description('Maximum number of what-if changes returned to a caller.')
@minValue(1)
param deploymentMaxPreviewChanges int = 200

@description('Maximum number of concurrent deployments this replica will start.')
@minValue(1)
param deploymentMaxConcurrent int = 2

@description('Where deployment records are kept. Production must use azure-table.')
@allowed(['memory', 'azure-table'])
param deploymentRecordStore string = 'memory'

@description('Table service endpoint of the record storage account.')
param deploymentRecordTableEndpoint string = ''

@description('Table holding deployment records.')
param deploymentRecordTableName string = 'deploymentrecords'

@description('Table holding per-scope deployment locks.')
param deploymentLockTableName string = 'deploymentlocks'

@description('Maximum accepted request body size, in bytes. Bicep bundles need headroom.')
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

@description('Log level for the server.')
@allowed(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
param logLevel string = 'info'

@description('CPU cores per replica, as a string so it survives JSON parameter files, e.g. "0.5".')
param cpu string = '0.5'

@description('Memory per replica, e.g. "1Gi". Must pair with the CPU value Container Apps allows.')
param memory string = '1Gi'

@description('''
Minimum number of replicas. Zero lets the app scale to nothing when idle, which is what makes a
low-traffic server nearly free to run: Container Apps bills per second of running replica, so a
permanently warm replica costs money around the clock whether or not anyone calls it. The trade is
a cold start of a few seconds on the first request after an idle period.
''')
@minValue(0)
param minReplicas int = 0

@description('Maximum number of replicas.')
@minValue(1)
param maxReplicas int = 3

@description('Concurrent requests per replica before Container Apps scales out.')
@minValue(1)
param httpConcurrentRequests int = 20

var deploymentIdentityConfigured = !empty(deploymentIdentityId)

var userAssignedIdentities = deploymentIdentityConfigured
  ? {
      '${identityId}': {}
      '${deploymentIdentityId}': {}
    }
  : {
      '${identityId}': {}
    }

// Optional settings are omitted entirely rather than declared as empty strings. An absent
// PUBLIC_BASE_URL means "not configured", not "configured to nothing", and the server validates its
// environment strictly at startup: an empty string fails url parsing and the container exits. The
// app deployment that first creates the ingress has no hostname to supply.
var optionalEnv = concat(
  empty(publicBaseUrl) ? [] : [{ name: 'PUBLIC_BASE_URL', value: publicBaseUrl }],
  empty(bicepCliSha256) ? [] : [{ name: 'BICEP_CLI_SHA256', value: bicepCliSha256 }],
  empty(deploymentRecordTableEndpoint)
    ? []
    : [{ name: 'DEPLOYMENT_RECORD_TABLE_ENDPOINT', value: deploymentRecordTableEndpoint }],
  deploymentIdentityConfigured
    ? [{ name: 'AZURE_DEPLOYMENT_CLIENT_ID', value: deploymentIdentityClientId }]
    : []
)

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
    userAssignedIdentities: userAssignedIdentities
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
            cpu: json(cpu)
            memory: memory
          }
          env: concat(
            [
              { name: 'NODE_ENV', value: 'production' }
              { name: 'PORT', value: '8080' }
              { name: 'LOG_LEVEL', value: logLevel }
              { name: 'SERVICE_NAME', value: appName }
              { name: 'SERVICE_VERSION', value: serviceVersion }
              { name: 'GIT_SHA', value: gitSha }
              { name: 'AUTH_MODE', value: 'api-key' }
              { name: 'API_KEYS', secretRef: 'connector-api-key' }
              { name: 'REQUEST_TIMEOUT_MS', value: string(requestTimeoutMs) }
              { name: 'SHUTDOWN_GRACE_MS', value: string(shutdownGraceMs) }
              { name: 'HTTP_MAX_BODY_BYTES', value: string(maxBodyBytes) }
              { name: 'RATE_LIMIT_MAX', value: string(rateLimitMax) }
              { name: 'RATE_LIMIT_WINDOW_MS', value: string(rateLimitWindowMs) }
              { name: 'AZURE_CLIENT_ID', value: identityClientId }
              { name: 'AZURE_SUBSCRIPTION_IDS', value: allowedSubscriptionIds }
              { name: 'AZURE_ALLOWED_RESOURCE_GROUPS', value: allowedResourceGroups }
              { name: 'AZURE_ALLOWED_MANAGEMENT_GROUP_IDS', value: allowedManagementGroupIds }
              {
                name: 'AZURE_TENANT_DEPLOYMENTS_ENABLED'
                value: toLower(string(tenantDeploymentsEnabled))
              }
              { name: 'AZURE_VERIFY_RBAC', value: toLower(string(verifyRbac)) }
              { name: 'MUTATIONS_ENABLED', value: toLower(string(mutationsEnabled)) }
              {
                name: 'MUTATION_CONFIRMATION_REQUIRED'
                value: toLower(string(mutationConfirmationRequired))
              }
              { name: 'MCP_HTTP_ENABLED', value: toLower(string(mcpHttpEnabled)) }
              { name: 'DEPLOYMENTS_ENABLED', value: toLower(string(deploymentsEnabled)) }
              { name: 'BICEP_CLI_PATH', value: deploymentsEnabled ? bicepCliPath : '' }
              { name: 'BICEP_COMPILE_TIMEOUT_MS', value: string(bicepCompileTimeoutMs) }
              { name: 'BICEP_MAX_CONCURRENCY', value: string(bicepMaxConcurrency) }
              { name: 'BICEP_MAX_FILES', value: string(bicepMaxFiles) }
              { name: 'BICEP_MAX_FILE_BYTES', value: string(bicepMaxFileBytes) }
              { name: 'BICEP_MAX_TOTAL_BYTES', value: string(bicepMaxTotalBytes) }
              {
                name: 'BICEP_REMOTE_MODULES_ENABLED'
                value: toLower(string(bicepRemoteModulesEnabled))
              }
              { name: 'BICEP_ALLOWED_REGISTRIES', value: bicepAllowedRegistries }
              { name: 'DEPLOYMENT_PREVIEW_TTL_MS', value: string(deploymentPreviewTtlMs) }
              {
                name: 'DEPLOYMENT_MAX_PREVIEW_CHANGES'
                value: string(deploymentMaxPreviewChanges)
              }
              { name: 'DEPLOYMENT_MAX_CONCURRENT', value: string(deploymentMaxConcurrent) }
              { name: 'DEPLOYMENT_RECORD_STORE', value: deploymentRecordStore }
              { name: 'DEPLOYMENT_RECORD_TABLE_NAME', value: deploymentRecordTableName }
              { name: 'DEPLOYMENT_LOCK_TABLE_NAME', value: deploymentLockTableName }
            ],
            optionalEnv
          )
          probes: [
            {
              // Liveness asks only whether the process is up. A readiness failure must not restart
              // a container that is running perfectly well but is waiting on a dependency.
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
                path: '/ready'
                port: 8080
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
            {
              type: 'Startup'
              httpGet: {
                path: '/health'
                port: 8080
              }
              initialDelaySeconds: 2
              periodSeconds: 3
              failureThreshold: 20
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
                concurrentRequests: string(httpConcurrentRequests)
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
