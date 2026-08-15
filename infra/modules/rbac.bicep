targetScope = 'subscription'

metadata description = '''
Assigns the server's roles at the narrowest scope the operator has configured.

When resource groups are named, assignments are made in those groups only; the subscription-wide
form is used only when the operator has deliberately left the group list empty. The deployment
identity is assigned separately from the operator identity and never receives the operator role.
'''

@description('Principal id of the read and operator identity.')
param operatorPrincipalId string

@description('Principal id of the deployment identity. Empty means deployments are not enabled.')
param deploymentPrincipalId string = ''

@description('Built-in role definition ids granted to the operator identity for reading.')
param readRoleDefinitionIds array

@description('Custom operator role definition id, assigned only when mutations are enabled.')
param operatorRoleDefinitionId string = ''

@description('Custom deployment runner role definition id, assigned only when deployments are enabled.')
param deploymentRoleDefinitionId string = ''

@description('Resource groups to scope every assignment to. Empty means subscription scope.')
param resourceGroupNames array = []

var operatorRoles = empty(operatorRoleDefinitionId)
  ? readRoleDefinitionIds
  : concat(readRoleDefinitionIds, [operatorRoleDefinitionId])

var assignDeployment = !empty(deploymentPrincipalId) && !empty(deploymentRoleDefinitionId)
var useSubscriptionScope = empty(resourceGroupNames)

resource operatorSubscriptionScoped 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for roleId in (useSubscriptionScope ? operatorRoles : []): {
    name: guid(subscription().id, operatorPrincipalId, roleId)
    properties: {
      principalId: operatorPrincipalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: contains(roleId, '/')
        ? roleId
        : subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleId)
    }
  }
]

resource deploymentSubscriptionScoped 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignDeployment && useSubscriptionScope) {
  name: guid(subscription().id, deploymentPrincipalId, deploymentRoleDefinitionId)
  properties: {
    principalId: deploymentPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: deploymentRoleDefinitionId
  }
}

module operatorGroupScoped 'role-assignment-rg.bicep' = [
  for groupName in resourceGroupNames: {
    name: 'rbac-op-${uniqueString(operatorPrincipalId, groupName)}'
    scope: resourceGroup(groupName)
    params: {
      principalId: operatorPrincipalId
      roleDefinitionIds: operatorRoles
    }
  }
]

module deploymentGroupScoped 'role-assignment-rg.bicep' = [
  for groupName in (assignDeployment ? resourceGroupNames : []): {
    name: 'rbac-dep-${uniqueString(deploymentPrincipalId, groupName)}'
    scope: resourceGroup(groupName)
    params: {
      principalId: deploymentPrincipalId
      roleDefinitionIds: [deploymentRoleDefinitionId]
    }
  }
]
