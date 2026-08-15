import type { z } from 'zod';
import type { Services } from '../services/index.js';

/** Transport that carried a call. Recorded on every audit record. */
export type ToolTransport = 'http' | 'mcp-stdio' | 'mcp-http';

export interface ToolInvocationContext {
  readonly requestId: string;
  readonly principal: string;
  readonly transport: ToolTransport;
  /** Cancelled when the caller disconnects or the request times out. */
  readonly signal?: AbortSignal | undefined;
}

export type ToolKind = 'read' | 'write';

/**
 * MCP tool annotations. They are declared per tool rather than derived from {@link ToolKind}
 * alone, because "changes state" and "destroys state" are different promises: deploying a
 * template is consequential but not necessarily destructive, while a rollback explicitly is.
 */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/**
 * Routing guidance. Every field is rendered into the description that agents see, so a model can
 * decide between twelve overlapping Azure tools without trial and error.
 */
export interface ToolRouting {
  /** Concrete situations where this tool is the right choice. */
  readonly useWhen: readonly string[];
  /** Situations where a different tool is better, naming that tool. */
  readonly doNotUseWhen: readonly string[];
  /** Azure scope the call needs, in the caller's terms. */
  readonly requiredScope: string;
  readonly changesState: boolean;
  /** Tools that normally have to succeed first. */
  readonly prerequisites?: readonly string[];
  /** Tools that normally follow. */
  readonly nextSteps?: readonly string[];
}

export interface ToolDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly title: string;
  /** One-line description surfaced in tool listings and the OpenAPI summary. */
  readonly summary: string;
  /** What the tool does. Routing guidance is added separately from {@link routing}. */
  readonly description: string;
  readonly kind: ToolKind;
  readonly routing: ToolRouting;
  /** Defaults are derived from {@link kind} when omitted. */
  readonly annotations?: Partial<ToolAnnotations>;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly handler: (
    input: z.output<InputSchema>,
    services: Services,
    context: ToolInvocationContext,
  ) => Promise<z.output<OutputSchema>>;
}

/** Identity helper that preserves the concrete schema types when declaring a tool. */
export const defineTool = <InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  definition: ToolDefinition<InputSchema, OutputSchema>,
): ToolDefinition<InputSchema, OutputSchema> => definition;

export const defaultAnnotations = (definition: ToolDefinition): ToolAnnotations => ({
  readOnlyHint: definition.kind === 'read',
  destructiveHint: definition.kind === 'write',
  idempotentHint: definition.kind === 'read',
  openWorldHint: true,
  ...definition.annotations,
});

const bullets = (heading: string, entries: readonly string[]): readonly string[] =>
  entries.length === 0 ? [] : [heading, ...entries.map((entry) => `- ${entry}`)];

/**
 * Renders the description an agent actually reads. Built from structured data so that every tool
 * answers the same three questions in the same order: what it does, when it applies, and what it
 * costs to be wrong.
 */
export const composeDescription = (definition: ToolDefinition): string =>
  [
    definition.description.trim(),
    '',
    definition.routing.changesState
      ? 'State: CHANGES Azure state. Preview first, then obtain explicit user approval, then execute, then verify.'
      : 'State: read-only. Safe to call while investigating.',
    `Required scope: ${definition.routing.requiredScope}`,
    '',
    ...bullets('Use when:', definition.routing.useWhen),
    ...bullets('Do not use when:', definition.routing.doNotUseWhen),
    ...bullets('Run these first:', definition.routing.prerequisites ?? []),
    ...bullets('Typical next steps:', definition.routing.nextSteps ?? []),
  ]
    .join('\n')
    .trim();
