@description('Principal id of the connector managed identity.')
param principalId string

@description('Role definition ids to assign at this resource group scope.')
param roleDefinitionIds array

resource assignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for roleId in roleDefinitionIds: {
    name: guid(resourceGroup().id, principalId, roleId)
    properties: {
      principalId: principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleId)
    }
  }
]
