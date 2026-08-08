import { z } from 'zod';
import { badRequest, notFound, toAppError } from '../errors.js';
import type { Services } from '../services/index.js';
import {
  toolDefinitions,
  type ToolDefinition,
  type ToolInvocationContext,
  type ToolKind,
} from './definitions.js';

export type { ToolInvocationContext, ToolKind };

/** Type-erased view of a tool, used by every transport. */
export interface RegisteredTool {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly inputJsonSchema: Record<string, unknown>;
  readonly outputJsonSchema: Record<string, unknown>;
  invoke(rawInput: unknown, services: Services, context: ToolInvocationContext): Promise<unknown>;
}

const toJsonSchema = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, { io: 'input', target: 'draft-7', unrepresentable: 'any' });

const toOutputJsonSchema = (schema: z.ZodType): Record<string, unknown> =>
  z.toJSONSchema(schema, { io: 'output', target: 'draft-7', unrepresentable: 'any' });

const erase = (definition: ToolDefinition): RegisteredTool => ({
  name: definition.name,
  title: definition.title,
  summary: definition.summary,
  description: definition.description,
  kind: definition.kind,
  inputSchema: definition.inputSchema,
  outputSchema: definition.outputSchema,
  inputJsonSchema: toJsonSchema(definition.inputSchema),
  outputJsonSchema: toOutputJsonSchema(definition.outputSchema),
  async invoke(rawInput, services, context) {
    const parsed = definition.inputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      throw badRequest(`Invalid input for tool ${definition.name}`, {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    try {
      return await definition.handler(parsed.data, services, context);
    } catch (error) {
      throw toAppError(error);
    }
  },
});

export class ToolRegistry {
  private readonly tools: ReadonlyMap<string, RegisteredTool>;

  public constructor(definitions: readonly ToolDefinition[]) {
    const map = new Map<string, RegisteredTool>();
    for (const definition of definitions) {
      if (map.has(definition.name)) {
        throw new Error(`Duplicate tool name in registry: ${definition.name}`);
      }
      map.set(definition.name, erase(definition));
    }
    this.tools = map;
  }

  public list(): readonly RegisteredTool[] {
    return [...this.tools.values()];
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public get(name: string): RegisteredTool {
    const tool = this.tools.get(name);
    if (!tool) throw notFound(`Unknown tool: ${name}`, { availableTools: [...this.tools.keys()] });
    return tool;
  }

  public invoke(
    name: string,
    rawInput: unknown,
    services: Services,
    context: ToolInvocationContext,
  ): Promise<unknown> {
    return this.get(name).invoke(rawInput, services, context);
  }
}

export const createToolRegistry = (
  definitions: readonly ToolDefinition[] = toolDefinitions,
): ToolRegistry => new ToolRegistry(definitions);
