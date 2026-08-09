metadata description = '''
A shared Azure Portal dashboard giving an at-a-glance answer to "are my connectors up?".

Takes a list of connectors rather than hardcoding one, so a dashboard can span every connector
in the subscription. Each entry contributes an availability chart driven by the Application
Insights availability test, which is the only signal that reflects reality for a service that
scales to zero: replica counts and CPU read as nothing when the app is idle and healthy.
'''

@description('Dashboard resource name.')
param name string

@description('Display name shown in the portal.')
param displayName string

@description('Azure region for the dashboard resource.')
param location string

@description('Connectors to chart. Each entry needs a label and the Application Insights component resource id backing its availability test.')
param connectors array

@description('Tags applied to the dashboard.')
param tags object = {}

var chartTiles = [
  for (connector, index) in connectors: {
    position: {
      x: index % 2 == 0 ? 0 : 6
      y: 1 + (index / 2) * 4
      rowSpan: 4
      colSpan: 6
    }
    metadata: {
      type: 'Extension/HubsExtension/PartType/MonitorChartPart'
      inputs: [
        {
          name: 'sharedTimeRange'
          isOptional: true
        }
        {
          name: 'options'
          isOptional: true
          value: {
            chart: {
              metrics: [
                {
                  resourceMetadata: {
                    id: connector.componentId
                  }
                  name: 'availabilityResults/availabilityPercentage'
                  aggregationType: 4
                  namespace: 'microsoft.insights/components'
                  metricVisualization: {
                    displayName: 'Availability %'
                  }
                }
              ]
              title: '${connector.label} availability'
              titleKind: 1
              visualization: {
                chartType: 2
                legendVisualization: {
                  isVisible: false
                }
                axisVisualization: {
                  y: {
                    isVisible: true
                    axisType: 2
                  }
                }
              }
              timespan: {
                relative: {
                  durationMs: 86400000
                }
                showUTCTime: false
                grain: 1
              }
            }
          }
        }
      ]
    }
  }
]

var headerTile = [
  {
    position: {
      x: 0
      y: 0
      rowSpan: 1
      colSpan: 12
    }
    metadata: {
      type: 'Extension/HubsExtension/PartType/MarkdownPart'
      inputs: []
      settings: {
        content: {
          settings: {
            content: '100% means every probe location reached the connector. These services scale to zero when idle, so a cold start after a quiet period is normal and does not count as downtime. An alert emails and texts if two or more probe locations fail.'
            title: displayName
            subtitle: 'Availability over the last 24 hours'
            markdownSource: 1
          }
        }
      }
    }
  }
]

var tiles = concat(headerTile, chartTiles)

resource dashboard 'Microsoft.Portal/dashboards@2020-09-01-preview' = {
  name: name
  location: location
  tags: union(tags, {
    'hidden-title': displayName
  })
  properties: {
    lenses: [
      {
        order: 0
        parts: tiles
      }
    ]
    metadata: {
      model: {
        timeRange: {
          value: {
            relative: {
              duration: 24
              timeUnit: 1
            }
          }
          type: 'MsPortalFx.Composition.Configuration.ValueTypes.TimeRange'
        }
      }
    }
  }
}

output dashboardId string = dashboard.id
