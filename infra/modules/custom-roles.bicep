targetScope = 'subscription'

metadata description = '''
Custom role definitions scoped to exactly the verbs this server can issue.

Built-in roles such as Virtual Machine Contributor, Website Contributor and Tag Contributor grant
far more than restart, start and tag: they allow creating, resizing and deleting the resources they
cover. These definitions grant the individual actions the operations service actually calls, so the
blast radius of a compromised token matches the blast radius of the tool surface.
'''

@description('Prefix used to name the role definitions, e.g. the workload and environment name.')
@minLength(3)
@maxLength(48)
param namePrefix string

@description('Create the deployment runner role. Only needed when generic Bicep deployment is enabled.')
param includeDeploymentRunner bool = false

// Role definition names must be unique within a tenant, so they are derived from the subscription
// as well as the prefix.
var operatorRoleName = guid(subscription().id, namePrefix, 'operator')
var deploymentRoleName = guid(subscription().id, namePrefix, 'deployment-runner')

resource operatorRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: operatorRoleName
  properties: {
    roleName: '${namePrefix} Operator'
    description: 'Restart and start virtual machines, restart App Service sites, and write resource tags. Nothing else.'
    type: 'CustomRole'
    assignableScopes: [subscription().id]
    permissions: [
      {
        actions: [
          'Microsoft.Compute/virtualMachines/restart/action'
          'Microsoft.Compute/virtualMachines/start/action'
          'Microsoft.Web/sites/restart/action'
          'Microsoft.Resources/tags/read'
          'Microsoft.Resources/tags/write'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
  }
}

// Deploying arbitrary Bicep needs permission to create the deployment itself *and* to write every
// resource type the template declares. Only the first is granted here: the second is a deliberate
// decision for whoever owns the subscription, made per resource type, and is documented rather
// than quietly assumed.
resource deploymentRunnerRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' =
  if (includeDeploymentRunner) {
    name: deploymentRoleName
    properties: {
      roleName: '${namePrefix} Deployment Runner'
      description: 'Create, preview and read ARM deployments. Grants no permission to create the resources a template declares; assign those separately.'
      type: 'CustomRole'
      assignableScopes: [subscription().id]
      permissions: [
        {
          actions: [
            '*/read'
            'Microsoft.Resources/deployments/read'
            'Microsoft.Resources/deployments/write'
            'Microsoft.Resources/deployments/validate/action'
            'Microsoft.Resources/deployments/whatIf/action'
            'Microsoft.Resources/deployments/operations/read'
            'Microsoft.Resources/deployments/operationstatuses/read'
            'Microsoft.Resources/deployments/exportTemplate/action'
          ]
          notActions: []
          dataActions: []
          notDataActions: []
        }
      ]
    }
  }

output operatorRoleDefinitionId string = operatorRole.id
output operatorRoleDefinitionName string = operatorRoleName
output deploymentRunnerRoleDefinitionId string = includeDeploymentRunner
  ? deploymentRunnerRole!.id
  : ''
output deploymentRunnerRoleDefinitionName string = includeDeploymentRunner ? deploymentRoleName : ''
