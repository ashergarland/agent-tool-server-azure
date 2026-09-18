import type { CapabilityManifest } from '@agent-tool-platform/runtime/capability';
import packageManifest from '../package.json' with { type: 'json' };

export const capabilityManifest: CapabilityManifest = {
  name: 'agent-tool-server-azure',
  version: packageManifest.version,
  title: 'Azure Agent Tool Server',
  description:
    'Inspect, diagnose, operate, and deploy Azure through a provider-backed, guard-railed control plane.',
  documentationUrl: 'https://github.com/ashergarland/agent-tool-server-azure#readme',
};
