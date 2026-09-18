#!/usr/bin/env node
import { startAgentToolApplication } from '@agent-tool-platform/runtime/capability';
import { capability } from './capability.js';

await startAgentToolApplication(capability);
