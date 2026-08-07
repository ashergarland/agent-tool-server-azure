import { describe, expect, it, vi } from 'vitest';
import { DiagnosticsService } from '../../src/services/diagnostics.js';
import { Guardrails } from '../../src/services/guardrails.js';
import { testConfig } from '../helpers/config.js';
import { SUB_A, createFakeProvider, webAppId } from '../helpers/fake-provider.js';
import type {
  ActivityLogQueryInput,
  MetricsQueryInput,
  ResourceGraphQueryInput,
} from '../../src/provider/types.js';

const NOW = new Date('2026-01-01T12:00:00.000Z');

const setup = (overrides: Record<string, string> = {}) => {
  const listMetrics = vi.fn((_input: MetricsQueryInput) =>
    Promise.resolve([
      {
        name: 'CpuPercentage',
        unit: 'Percent',
        aggregation: 'Average',
        dataPoints: [{ timestamp: NOW.toISOString(), value: 42 }],
      },
    ]),
  );
  const provider = createFakeProvider({ listMetrics });
  const service = new DiagnosticsService(
    provider,
    new Guardrails(testConfig(overrides)),
    () => NOW,
  );
  return { provider, service, listMetrics };
};

describe('DiagnosticsService', () => {
  it('converts the lookback window into an absolute time range', async () => {
    const { provider, service } = setup();
    await service.getActivityLog({ subscriptionId: SUB_A, lookbackHours: 6, limit: 10 });

    const input = provider.calls.find((call) => call.name === 'listActivityLog')
      ?.args[0] as ActivityLogQueryInput;
    expect(input.until).toEqual(NOW);
    expect(input.since).toEqual(new Date('2026-01-01T06:00:00.000Z'));
    expect(input.top).toBe(10);
  });

  it('enforces scope on activity log reads', async () => {
    const { service } = setup({ AZURE_SUBSCRIPTION_IDS: SUB_A });
    await expect(
      service.getActivityLog({
        subscriptionId: '99999999-9999-9999-9999-999999999999',
        lookbackHours: 1,
        limit: 10,
      }),
    ).rejects.toThrow(/allow-list/);
  });

  it('returns metric series with the resolved timespan', async () => {
    const { service, listMetrics } = setup();
    const result = await service.getMetrics({
      resourceId: webAppId(),
      metricNames: ['CpuPercentage'],
      lookbackHours: 2,
      intervalIso8601: 'PT5M',
      aggregation: 'Average',
    });

    expect(result.timespan).toEqual({
      start: '2026-01-01T10:00:00.000Z',
      end: NOW.toISOString(),
    });
    expect(result.series[0]?.dataPoints[0]?.value).toBe(42);

    const input = listMetrics.mock.calls[0]?.[0];
    expect(input?.metricNames).toEqual(['CpuPercentage']);
    expect(input?.intervalIso8601).toBe('PT5M');
  });

  it('rejects metric queries without metric names', async () => {
    const { service } = setup();
    await expect(
      service.getMetrics({
        resourceId: webAppId(),
        metricNames: [],
        lookbackHours: 1,
        intervalIso8601: 'PT5M',
        aggregation: 'Average',
      }),
    ).rejects.toThrow(/At least one metric name/);
  });

  it('queries resource health for non-available resources only', async () => {
    const { provider, service } = setup();
    await service.getUnhealthyResources({ subscriptionIds: [SUB_A], limit: 50 });

    const input = provider.calls.find((call) => call.name === 'queryResourceGraph')
      ?.args[0] as ResourceGraphQueryInput;
    expect(input.query).toContain('healthresources');
    expect(input.query).toContain("availabilityState !~ 'Available'");
  });
});
