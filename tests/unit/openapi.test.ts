import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../src/openapi/document.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { testConfig } from '../helpers/config.js';

const document = buildOpenApiDocument(testConfig(), createToolRegistry()) as Record<
  string,
  unknown
>;

/**
 * ChatGPT rejects an imported Action schema when an object schema declares no properties, so a
 * bare `{ type: 'object' }` anywhere in the document blocks the connector from being registered.
 * Walking the whole document means a newly added tool cannot silently reintroduce the problem.
 */
const bareObjectSchemas = (node: unknown, path: string[] = []): string[] => {
  if (Array.isArray(node)) {
    return node.flatMap((entry, index) => bareObjectSchemas(entry, [...path, String(index)]));
  }
  if (node === null || typeof node !== 'object') return [];

  const record = node as Record<string, unknown>;
  const offenders: string[] = [];
  const declaresObject = record['type'] === 'object';
  const describesShape =
    'properties' in record ||
    'additionalProperties' in record ||
    'oneOf' in record ||
    'anyOf' in record ||
    'allOf' in record ||
    '$ref' in record;

  if (declaresObject && !describesShape) offenders.push(path.join('.') || '<root>');

  for (const [key, value] of Object.entries(record)) {
    offenders.push(...bareObjectSchemas(value, [...path, key]));
  }
  return offenders;
};

const operationDescriptions = (node: unknown): string[] => {
  if (node === null || typeof node !== 'object') return [];

  const paths = (node as Record<string, unknown>)['paths'];
  if (paths === null || typeof paths !== 'object') return [];

  return Object.values(paths as Record<string, unknown>).flatMap((path) => {
    if (path === null || typeof path !== 'object') return [];
    return Object.values(path as Record<string, unknown>).flatMap((operation) => {
      if (operation === null || typeof operation !== 'object') return [];
      const description = (operation as Record<string, unknown>)['description'];
      return typeof description === 'string' ? [description] : [];
    });
  });
};

describe('OpenAPI document', () => {
  const at = (node: unknown, ...path: string[]): unknown =>
    path.reduce<unknown>(
      (current, key) =>
        current === null || typeof current !== 'object'
          ? undefined
          : (current as Record<string, unknown>)[key],
      node,
    );

  const responseSchema = (path: string): unknown =>
    at(document, 'paths', path, 'get', 'responses', '200', 'content', 'application/json', 'schema');

  it('never emits an object schema without a declared shape', () => {
    expect(bareObjectSchemas(document)).toEqual([]);
  });

  it('keeps operation descriptions within the ChatGPT Actions limit', () => {
    expect(operationDescriptions(document).every((description) => description.length <= 300)).toBe(
      true,
    );
  });

  it('describes the /version payload so the importer can validate it', () => {
    const properties = at(responseSchema('/version'), 'properties');
    expect(properties).toMatchObject({
      service: { type: 'string' },
      version: { type: 'string' },
    });
    expect(at(properties, 'capabilities', 'properties', 'authMode')).toEqual({ type: 'string' });
  });

  it('describes the /tools catalogue as an array of tool entries', () => {
    const tools = at(responseSchema('/tools'), 'properties', 'tools');
    expect(at(tools, 'type')).toBe('array');
    expect(at(tools, 'items', 'properties', 'name')).toEqual({ type: 'string' });
  });

  it('keeps the documented /version shape in step with the served payload', () => {
    const documented = Object.keys(
      at(responseSchema('/version'), 'properties') as Record<string, unknown>,
    ).sort();
    expect(documented).toEqual(
      ['capabilities', 'environment', 'gitSha', 'node', 'service', 'version'].sort(),
    );
  });
});
