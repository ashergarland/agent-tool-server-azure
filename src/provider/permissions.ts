/** Generic ARM deployment operations exercised by the public Bicep workflow. */
export const DEPLOYMENT_REQUIRED_ACTIONS = [
  'Microsoft.Resources/deployments/write',
  'Microsoft.Resources/deployments/read',
  'Microsoft.Resources/deployments/whatIf/action',
  'Microsoft.Resources/deployments/operationStatuses/read',
  'Microsoft.Resources/deployments/operations/read',
] as const;
