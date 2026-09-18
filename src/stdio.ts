#!/usr/bin/env node
import { startStdioAgentToolApplication } from '@agent-tool-platform/runtime/capability';
import { capability } from './capability.js';

await startStdioAgentToolApplication(capability);
