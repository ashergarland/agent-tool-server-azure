metadata description = 'Assigns a set of role definitions to one principal inside a single resource group.'

@description('Principal id receiving the assignments.')
param principalId string

@description('Role definition ids. Either a bare GUID (built-in) or a fully qualified id (custom).')
param roleDefinitionIds array

resource assignments 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for roleId in roleDefinitionIds: {
    name: guid(resourceGroup().id, principalId, roleId)
    properties: {
      principalId: principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: contains(roleId, '/')
        ? roleId
        : subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleId)
    }
  }
]
