import { describe, it, expect } from 'vitest';
import { formatMetric } from '../../app/src/predictions-validation.js';

describe('formatMetric', () => {
  it('formats finite numbers with one decimal', () => {
    expect(formatMetric(12.345)).toBe('12.3');
    expect(formatMetric(0)).toBe('0.0');
  });

  it('shows a dash for metrics that are undefined', () => {
    // NaN becomes null in JSON, e.g. MAPE for a sensor whose actuals are all 0
    expect(formatMetric(null)).toBe('—');
    expect(formatMetric(NaN)).toBe('—');
    expect(formatMetric(undefined)).toBe('—');
    expect(formatMetric(Infinity)).toBe('—');
  });
});
