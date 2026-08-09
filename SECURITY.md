# Security policy

Security is a core design constraint of chatgpt-azure. The connector can receive credentials and
operate against real Azure resources, so suspected vulnerabilities must be handled privately.

## Supported versions

This project is currently pre-1.0. Security fixes are applied to the latest commit on `main`; older
commits and deployments are not supported. Pin deployments to a reviewed commit and monitor the
repository for updates.

## Report a vulnerability

Use GitHub's private vulnerability reporting flow:

<https://github.com/ashergarland/chatgpt-azure/security/advisories/new>

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

- restricting the managed identity with Azure RBAC;
- configuring subscription and resource-group allow-lists;
- keeping mutations disabled unless explicitly required;
- rotating connector credentials and limiting access to Key Vault;
- reviewing generated OpenAPI and infrastructure changes before deployment; and
- monitoring authentication failures, throttling, upstream errors, and mutation audit logs.

The [deployment guide](docs/deployment.md) contains hardening and operational guidance. Never use
sample credentials or unrestricted access in production.
