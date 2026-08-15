import { z } from 'zod';
import { badRequest, internalError, notFound, toAppError } from '../errors.js';
import type { Services } from '../services/index.js';
import { toolDefinitions } from './definitions/index.js';
import {
  composeDescription,
  defaultAnnotations,
  type ToolAnnotations,
  type ToolDefinition,
  type ToolInvocationContext,
  type ToolKind,
  type ToolRouting,
  type ToolTransport,
} from './types.js';

export type { ToolInvocationContext, ToolKind, ToolAnnotations, ToolRouting, ToolTransport };

/** Type-erased view of a tool, used by every transport. */
export interface RegisteredTool {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
  /** Description as declared, without routing guidance. */
  readonly baseDescription: string;
  /** Description agents see: declaration plus rendered routing guidance. */
  readonly description: string;
  readonly kind: ToolKind;
  readonly routing: ToolRouting;
  readonly annotations: ToolAnnotations;
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

const issuePaths = (error: z.ZodError): string[] =>
  error.issues.slice(0, 20).map((issue) => issue.path.join('.') || '(root)');

const erase = (definition: ToolDefinition): RegisteredTool => ({
  name: definition.name,
  title: definition.title,
  summary: definition.summary,
  baseDescription: definition.description,
  description: composeDescription(definition),
  kind: definition.kind,
  routing: definition.routing,
  annotations: defaultAnnotations(definition),
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

    let result: unknown;
    try {
      result = await definition.handler(parsed.data, services, context);
    } catch (error) {
      throw toAppError(error);
    }

    // Outputs are validated as strictly as inputs. A handler that has drifted from its declared
    // schema is a server defect, and must not reach the caller as a plausible-looking result that
    // the advertised JSON Schema promised. Only the offending paths are reported: the value itself
    // may contain Azure data that does not belong in an error payload.
    const validated = definition.outputSchema.safeParse(result);
    if (!validated.success) {
      throw internalError(
        `Tool ${definition.name} produced a result that does not match its declared output schema`,
        new Error(`invalid output paths: ${issuePaths(validated.error).join(', ')}`),
      );
    }
    return validated.data;
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
