@description('Name of the Log Analytics workspace backing the Container Apps environment.')
param name string

@description('Azure region.')
param location string

@description('Tags applied to the workspace.')
param tags object = {}

@description('Retention in days for connector logs.')
@minValue(30)
@maxValue(730)
param retentionInDays int = 30

@description('Hard ceiling on daily log ingestion, in GB. Log Analytics bills per GB ingested, so a stuck retry loop writing errors could otherwise run up a bill unattended. Capping it means logging degrades instead of spending.')
@minValue(1)
param dailyQuotaGb int = 1

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    workspaceCapping: {
      dailyQuotaGb: dailyQuotaGb
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

output id string = workspace.id
output customerId string = workspace.properties.customerId
output name string = workspace.name
