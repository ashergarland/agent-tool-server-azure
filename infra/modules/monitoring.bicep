metadata description = '''
Availability monitoring for the connector: an availability test that calls the public /health
endpoint from outside Azure, an action group that emails and texts a single owner, and an alert
that fires when the endpoint stops answering.

This deliberately probes over HTTP rather than watching replica counts. The connector scales to
zero when idle, so "no replicas running" is the normal, healthy, cheap state - alerting on it
would page constantly for a service that is working perfectly. Only a failed request means the
connector is actually unable to serve.
'''

@description('Base name used to derive monitor resource names.')
param name string

@description('Azure region for regional resources. Web tests and their alerts are pinned to the Application Insights component region.')
param location string

@description('Public HTTPS base URL of the connector, without a trailing slash.')
param connectorUrl string

@description('Log Analytics workspace backing the Application Insights component.')
param logAnalyticsWorkspaceId string

@description('Email addresses notified when the connector stops responding. Empty skips email.')
param alertEmails array = []

@description('Phone number notified by SMS, digits only, no country code. Leave empty to skip SMS.')
param alertSmsPhone string = ''

@description('Country code for the SMS number, e.g. 1 for the United States.')
param alertSmsCountryCode string = '1'

@description('Tags applied to every resource.')
param tags object = {}

// Receiver names must be unique within the action group, so they are derived from the index
// rather than the address, which also keeps the address out of the resource name.
var emailReceivers = [
  for (address, index) in alertEmails: {
    name: 'owner-email-${index}'
    emailAddress: address
    useCommonAlertSchema: true
  }
]

var smsReceivers = empty(alertSmsPhone)
  ? []
  : [
      {
        name: 'owner-sms'
        countryCode: alertSmsCountryCode
        phoneNumber: alertSmsPhone
      }
    ]

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${name}'
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalyticsWorkspaceId
    // The connector logs through Log Analytics directly; this component exists to host the
    // availability test, so there is no reason to let it sample and bill for ingestion.
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// A standard availability test calls the endpoint from Microsoft-managed locations, so it proves
// the connector is reachable from the public internet rather than merely alive inside Azure.
resource healthProbe 'Microsoft.Insights/webtests@2022-06-15' = {
  name: 'wt-${name}-health'
  location: location
  tags: union(tags, {
    'hidden-link:${insights.id}': 'Resource'
  })
  kind: 'standard'
  properties: {
    SyntheticMonitorId: 'wt-${name}-health'
    Name: '${name} health'
    Enabled: true
    Frequency: 300
    Timeout: 30
    Kind: 'standard'
    RetryEnabled: true
    Locations: [
      { Id: 'us-ca-sjc-azr' }
      { Id: 'us-tx-sn1-azr' }
      { Id: 'us-il-ch1-azr' }
    ]
    Request: {
      RequestUrl: '${connectorUrl}/health'
      HttpVerb: 'GET'
    }
    ValidationRules: {
      ExpectedHttpStatusCode: 200
      SSLCheck: true
      SSLCertRemainingLifetimeCheck: 7
    }
  }
}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-${name}'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: take(replace(name, '-', ''), 12)
    enabled: true
    emailReceivers: emailReceivers
    smsReceivers: smsReceivers
  }
}

resource healthAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'alert-${name}-unavailable'
  location: 'global'
  tags: tags
  properties: {
    description: 'The connector stopped answering /health from outside Azure.'
    severity: 1
    enabled: true
    scopes: [
      healthProbe.id
      insights.id
    ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria'
      webTestId: healthProbe.id
      componentId: insights.id
      // Alert once more than one probe location is failing, which distinguishes a genuine outage
      // from a single flaky region.
      failedLocationCount: 2
    }
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
  }
}

output applicationInsightsName string = insights.name
output actionGroupId string = actionGroup.id
output webTestId string = healthProbe.id
