metadata description = '''
Storage account holding deployment records.

Records live outside the container so that a Container App which scales to zero between calls does
not forget a pending preview, and so two replicas agree about what was approved. Access is by
managed identity only: shared keys are disabled, so there is no account key to leak or rotate.
'''

@description('Name of the storage account. Must be globally unique, 3-24 lower-case alphanumerics.')
@minLength(3)
@maxLength(24)
param name string

@description('Azure region.')
param location string

@description('Tags applied to the account.')
param tags object = {}

@description('Principal id of the deployment identity, granted table data access on this account.')
param deploymentPrincipalId string

@description('Table holding deployment records.')
param recordsTableName string = 'deploymentrecords'

@description('Table holding per-scope deployment locks.')
param locksTableName string = 'deploymentlocks'

// Storage Table Data Contributor. Scoped to this account only.
var tableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    // Managed identity only. With shared keys disabled there is no credential to steal, and the
    // audit trail in the storage account names a principal rather than "the account key".
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: account
  name: 'default'
}

resource recordsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: recordsTableName
}

resource locksTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: locksTableName
}

resource tableAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, deploymentPrincipalId, tableDataContributorRoleId)
  scope: account
  properties: {
    principalId: deploymentPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      tableDataContributorRoleId
    )
  }
}

output id string = account.id
output name string = account.name
output tableEndpoint string = account.properties.primaryEndpoints.table
output recordsTableName string = recordsTable.name
output locksTableName string = locksTable.name
