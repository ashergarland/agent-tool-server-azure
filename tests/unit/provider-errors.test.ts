import { describe, expect, it } from 'vitest';
import { AppError } from '@agent-tool-platform/runtime/errors';
import { mapAzureError } from '../../src/provider/azure/errors.js';
import {
  azureSdkOperationOptions,
  escapeKqlString,
  resourceGroupFromResourceId,
  subscriptionIdFromResourceId,
} from '../../src/provider/azure/index.js';
import { webAppId } from '../helpers/fake-provider.js';

describe('mapAzureError', () => {
  it.each([
    [403, 'forbidden'],
    [401, 'upstream_error'],
    [404, 'not_found'],
    [409, 'conflict'],
    [429, 'rate_limited'],
    [400, 'bad_request'],
    [500, 'upstream_error'],
    [504, 'timeout'],
  ])('maps HTTP %s to %s', (status, code) => {
    expect(mapAzureError({ statusCode: status, message: 'boom' }, 'ctx').code).toBe(code);
  });

  describe('Azure SDK transport options', () => {
    it('applies the provider timeout with or without caller cancellation', () => {
      const signal = new AbortController().signal;
      expect(azureSdkOperationOptions(30_000)).toEqual({
        requestOptions: { timeout: 30_000 },
      });
      expect(azureSdkOperationOptions(45_000, signal)).toEqual({
        abortSignal: signal,
        requestOptions: { timeout: 45_000 },
      });
    });
  });

  it('passes AppErrors through untouched', () => {
    const original = new AppError('bad_request', 'nope');
    expect(mapAzureError(original, 'ctx')).toBe(original);
  });

  it('maps credential failures to upstream errors', () => {
    const error = mapAzureError({ name: 'CredentialUnavailableError', message: 'no MI' }, 'ctx');
    expect(error.code).toBe('upstream_error');
    expect(error.message).toContain('no MI');
  });

  it('marks throttling as retryable', () => {
    expect(mapAzureError({ statusCode: 429 }, 'ctx').retryable).toBe(true);
  });
});

describe('resource id helpers', () => {
  it('extracts the subscription and resource group', () => {
    expect(subscriptionIdFromResourceId(webAppId())).toBe('11111111-1111-1111-1111-111111111111');
    expect(resourceGroupFromResourceId(webAppId())).toBe('rg-prod');
  });

  it('returns undefined for non-ARM ids', () => {
    expect(subscriptionIdFromResourceId('nonsense')).toBeUndefined();
    expect(resourceGroupFromResourceId('nonsense')).toBeUndefined();
  });
});

describe('escapeKqlString', () => {
  it('escapes quotes and backslashes', () => {
    expect(escapeKqlString("a'b")).toBe("a\\'b");
    expect(escapeKqlString('a\\b')).toBe('a\\\\b');
  });
});
