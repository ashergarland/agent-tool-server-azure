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

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

output id string = workspace.id
output customerId string = workspace.properties.customerId
output name string = workspace.name
