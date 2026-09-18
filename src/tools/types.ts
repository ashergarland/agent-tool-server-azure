import {
  defineTool as definePlatformTool,
  type ToolDefinition as PlatformToolDefinition,
} from '@agent-tool-platform/runtime/tools';
import type { z } from 'zod';
import type { Services } from '../services/index.js';

export type ToolDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> = PlatformToolDefinition<Services, InputSchema, OutputSchema>;

export const defineTool = <InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  definition: ToolDefinition<InputSchema, OutputSchema>,
): ToolDefinition<InputSchema, OutputSchema> => definePlatformTool(definition);
