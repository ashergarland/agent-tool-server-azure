# Threat model

This document states what the server defends against, how, and — more usefully — what it does not
defend against. Read it before enabling mutations or generic deployment.

## What this server is

A control plane that lets an agent read, diagnose, operate and deploy Azure through a fixed set of
typed tools. It holds Azure permissions of its own. Anyone who can call it can do, at most, what
those permissions plus the configured allow-lists plus the tool surface permit — and nothing else.

## Trust boundaries

| Boundary                | Who is on the far side          | What crosses it                                      |
| ----------------------- | ------------------------------- | ---------------------------------------------------- |
| Caller → server         | An agent, and whoever drives it | Tool name, JSON input, an API key or Entra token     |
| Server → Bicep compiler | A child process                 | A caller-supplied source bundle                      |
| Server → ARM            | Azure                           | Requests signed with the server's managed identities |
| Server → record store   | Azure Table Storage             | Deployment records, keyed by principal               |

**Assume the caller is hostile, or is a model being steered by hostile content.** Prompt injection
inside an Azure resource name, tag, activity-log entry or template comment is a realistic attack:
the mitigation is that no tool can be talked into doing anything outside its schema, and every
consequential action needs a human confirmation the model cannot forge.

## Caller authentication versus Azure authorisation

These are deliberately separate.

- **Caller authentication** answers "who is calling this server". API key (constant-time comparison
  against a per-process keyed digest) or an Entra JWT validated against the tenant's JWKS with
  audience, issuer and optional application allow-list checks.
- **Azure authorisation** answers "what may happen in Azure". ARM decides, by evaluating the
  server's own managed identity against RBAC.

A caller therefore cannot escalate by presenting better Azure credentials — there is nowhere to put
them. Deployment tool inputs are strict objects, so an attempt to pass `clientId`, `clientSecret` or
similar is a validation error, not an ignored field.

## Defences

### Blast radius

- Two user-assigned managed identities: one for reads and the four guarded operations, one used only
  for deployments. The deployment identity's permissions are never available to the read surface.
- Custom RBAC roles limited to the verbs the code issues (`virtualMachines/restart/action`,
  `virtualMachines/start/action`, `sites/restart/action`, `tags/write`) instead of the built-in
  Contributor roles, which also allow creation and deletion.
- The deployment runner role grants only the right to create ARM deployments and read resources. It
  does **not** grant the right to create the resources a template declares; those roles are assigned
  deliberately by whoever owns the subscription.
- Subscription, resource group and management group allow-lists, enforced in the service layer on
  every read and write, including nested deployment scopes. For deployments an empty subscription
  allow-list is refused rather than treated as "everything".
- Mutations and deployments are off by default and the roles that would enable them are not
  assigned by default.

### Consequential actions

- Guarded operations need `MUTATIONS_ENABLED`, `confirm=true` and a reason; dry runs always work.
- Deployments need `DEPLOYMENTS_ENABLED`, `confirm=true`, a reason, and a `confirmationHash` from a
  recent what-if over identical source, parameters, scope and mode. The server recompiles what it is
  sent and recomputes the hash; any difference is refused with `conflict`.
- Previews expire. Records are isolated per principal. A per-scope lock prevents two concurrent
  deployments to the same scope, and a retried deploy reports the existing deployment instead of
  starting a second one.
- Only Incremental mode is issued. ARM Complete mode, which deletes everything absent from the
  template, is never used and is refused in nested deployments.

### Source and compilation

- Callers supply a virtual bundle, never a path, a URL or a registry reference. Rejected: absolute
  and drive-qualified paths, `..` traversal, duplicate normalised paths (case-insensitively),
  reserved device names, control characters, invalid UTF-16, trailing dots or spaces, disallowed
  file types, a caller-supplied `bicepconfig.json`, and anything over the configured file count,
  file size, total size, path length or depth.
- The bundle is materialised into a fresh directory whose name carries 128 bits of randomness on top
  of `mkdtemp`, with files created exclusively (`wx`) so an existing entry — including a symlink —
  is an error rather than a target. The directory is always removed.
- The compiler is a pinned, checksum-verified official Bicep CLI installed at image build time and
  invoked directly: argv array, no shell, an environment constructed from nothing rather than
  inherited, non-root, wall-clock timeout, output cap, bounded concurrency, isolated working
  directory. The server never downloads a compiler at runtime.
- Compiler diagnostics are rewritten to bundle-relative paths, so a caller never learns where their
  source was materialised.

### Compiled template inspection

Refused anywhere in the template, including inside inline nested deployments:

- `Microsoft.Resources/deploymentScripts`, which executes arbitrary code during deployment.
- `templateLink`, `parametersLink`, `contentLink`, `contentUri`, `scriptUri`, `primaryScriptUri`,
  `supportingScriptUris`, `packageUri`, `fileUris`, `commandToExecute`.
- Nested deployments without an inline template, and nested deployments in Complete mode.
- Operator-denied resource types (by default the VM and Arc extension families).
- Unsupported deployment scopes, and any scope outside the allow-list.
- Structures that cannot be bounded or understood: a `resources` section that is neither an array
  nor an object, entries that are not objects, entries with no `type`, more resources or nested
  deployments than configured, deeper nesting than configured, templates over the size limit.

Role assignments and policy assignments are permitted but reported as warnings, because they need
privileged RBAC the deployment identity does not have by default.

### Information disclosure

- Secure parameter values are hashed into the confirmation, never stored. Sanitised parameters
  replace them, and any parameter whose name looks like a credential, with a redaction marker.
- What-if results report the path and kind of each property change but never `before`/`after`
  values, which come from live resources the caller may not be entitled to read.
- Deployment outputs typed `securestring`/`secureobject`, or named like secrets, are reported by
  name only.
- In production, `500`-class errors expose only a fixed message and the request id. The decision is
  taken from validated configuration, not from a mutable `process.env`.
- Audit logs record the principal, action, scope, deployment id, hashes, resource types, timestamps,
  reason, outcome and request id — never source, parameter values, tokens or unredacted outputs.

### Availability

- Rate limiting before authentication (per address) and after it (per principal), so an
  unauthenticated flood cannot force unbounded credential verification.
- Bounded request bodies, bundles, parameters, previews, outputs, pagination, compiler jobs and
  concurrent deployments.
- Request timeouts, cancellation on client disconnect, and a graceful drain on `SIGTERM`.

## Residual risk and non-goals

**A deployment can still do damage inside its permitted scope.** That is the point of a deployment
tool. The controls are the allow-lists, the roles you assign to the deployment identity, and the
human approval step — not the template inspector. Grant narrowly.

**Rollback is a redeploy, not an undo.** It reapplies a previous template after a fresh preview and
a new confirmation. It does not restore deleted resources, revert data-plane changes (blobs, rows,
messages), or undo changes made outside this server. Some ARM changes are irreversible.

**What-if is a prediction, not a guarantee.** ARM cannot evaluate every provider, and reports some
changes as unsupported or ignored. Those are surfaced verbatim. State can also change between the
preview and the deployment; the confirmation hash binds the _plan_, not the world.

**Remote modules are a supply-chain decision.** With `BICEP_REMOTE_MODULES_ENABLED=true` the
compiler is allowed to reach configured OCI registries or Template Specs during restore. Content
pulled that way is inspected after compilation like any other template, but you are trusting the
registry, its tags and its transport. It is off by default for that reason.

**The record store sees deployment metadata.** Compiled templates are retained to make rollback
possible. Anyone with data-plane access to that storage account can read them. They contain no
secure parameter values, but they do describe your infrastructure. The account is created with
shared-key access disabled so access is by managed identity and is attributable.

**An API key is a bearer credential.** Anyone holding it can do everything the server can do. Rotate
it (see the deployment guide), prefer `entra-jwt` where the client supports it, and never put it in
a URL or a log.

**Prompt injection cannot be eliminated.** A model reading a hostile resource description may be
persuaded to _attempt_ something. It cannot exceed the tool surface, the schemas, the allow-lists or
the confirmation requirement — which is why those, and not the model's judgement, are the control.

**Denial of wallet.** A caller with deployment rights can create billable resources within the
permitted scope. Use Azure budgets and policy; this server bounds _what_ can be deployed and _where_,
not what it costs.

## Reporting

Report vulnerabilities privately as described in [SECURITY.md](../SECURITY.md).
