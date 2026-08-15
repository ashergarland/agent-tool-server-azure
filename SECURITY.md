# Security policy

Security is a core design constraint of agent-tool-server-azure. The server can receive credentials and
operate against real Azure resources, so suspected vulnerabilities must be handled privately.

## Supported versions

This project is currently pre-1.0. Security fixes are applied to the latest commit on `main`; older
commits and deployments are not supported. Pin deployments to a reviewed commit and monitor the
repository for updates.

## Report a vulnerability

Use GitHub's private vulnerability reporting flow:

<https://github.com/ashergarland/agent-tool-server-azure/security/advisories/new>

Do not open a public issue, discussion, or pull request for an undisclosed vulnerability. Include:

- the affected commit or version;
- the required configuration and Azure permissions;
- clear reproduction steps or a minimal proof of concept;
- the potential impact and blast radius; and
- any suggested remediation.

Remove credentials, tenant or subscription identifiers, resource names, and sensitive logs. The
maintainer will acknowledge the report, investigate it, and coordinate a fix and disclosure. Please
allow a reasonable remediation period before publishing details.

If private vulnerability reporting is unavailable, open a public issue containing no vulnerability
details and ask the maintainer to establish a private reporting channel.

## Deployment responsibilities

Operators are responsible for:

- restricting the operator and deployment managed identities with Azure RBAC, and never granting
  the deployment identity Owner;
- configuring subscription, resource group and management group allow-lists;
- keeping mutations and generic deployment disabled unless explicitly required;
- pinning the Bicep compiler digest (`BICEP_CLI_SHA256`) wherever deployments are enabled;
- keeping remote Bicep module restore disabled unless the registries involved are trusted;
- rotating API keys and limiting access to Key Vault and the deployment record storage account;
- reviewing the generated OpenAPI document, the parameter files and infrastructure changes before
  deployment; and
- monitoring authentication failures, throttling, upstream errors, and the mutation and deployment
  audit logs.

The [deployment guide](docs/deployment.md) contains hardening and operational guidance, and the
[threat model](docs/threat-model.md) states what the server does and does not defend against. Never
use sample credentials or unrestricted access in production.
