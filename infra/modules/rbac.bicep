targetScope = 'subscription'

@description('Principal id of the connector managed identity.')
param principalId string

@description('Role definition ids to assign at subscription scope.')
param roleDefinitionIds array

@description('Optional resource groups to scope the assignments to. Empty means subscription scope.')
param resourceGroupNames array = []

var subscriptionAssignments = empty(resourceGroupNames) ? roleDefinitionIds : []

resource subscriptionScoped 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for roleId in subscriptionAssignments: {
    name: guid(subscription().id, principalId, roleId)
    properties: {
      principalId: principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleId)
    }
  }
]

module resourceGroupScoped 'role-assignment-rg.bicep' = [
  for groupName in resourceGroupNames: {
    name: 'rbac-${uniqueString(principalId, groupName)}'
    scope: resourceGroup(groupName)
    params: {
      principalId: principalId
      roleDefinitionIds: roleDefinitionIds
    }
  }
]
