/**
 * The control plane reports a disabled task exactly once per process, so a
 * report arriving before initMetrics is that signal's only chance — it must be
 * queued and flushed when the gauge exists, not dropped.
 */
import { describe, it, expect, vi } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { initMetrics, recordBackgroundTaskDisabled } from '../metrics.js';

describe('recordBackgroundTaskDisabled before initMetrics', () => {
  it('queues the report and flushes it onto the gauge at initMetrics', () => {
    const instrument = { add: vi.fn(), record: vi.fn() };
    const disabledGauge = { add: vi.fn() };
    const meter = {
      createCounter: () => instrument,
      createHistogram: () => instrument,
      createUpDownCounter: (name: string) =>
        name === 'aflow.background_task.disabled' ? disabledGauge : instrument,
    };
    // First registration wins in the OTel API, so initMetrics' own provider
    // never displaces this stub and getMeter('aflow') resolves to it.
    metrics.setGlobalMeterProvider({ getMeter: () => meter } as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    recordBackgroundTaskDisabled('orchestrator.projection', 'break_glass');
    expect(disabledGauge.add).not.toHaveBeenCalled();

    initMetrics({ serviceName: 'flush-test', otlpEndpoint: '' });

    expect(disabledGauge.add).toHaveBeenCalledWith(1, {
      background_task_id: 'orchestrator.projection',
      reason: 'break_glass',
    });
  });
});
