import { describe, it, expect } from 'vitest';
import { extractWindow, getQuarterStart } from '../../lib/time-series-utils.js';

describe('Time Series Utils', () => {
  describe('getQuarterStart', () => {
    it('rounds down to the nearest 15 minutes', () => {
      const d = new Date('2024-01-01T10:22:00Z');
      const start = getQuarterStart(d);
      expect(new Date(start).toISOString()).toBe('2024-01-01T10:15:00.000Z');
    });

    it('handles exact 15 minute boundaries', () => {
      const d = new Date('2024-01-01T10:30:00.000Z');
      const start = getQuarterStart(d);
      expect(new Date(start).toISOString()).toBe('2024-01-01T10:30:00.000Z');
    });
  });

  describe('extractWindow', () => {
    const stepMs = 15 * 60 * 1000;
    const baseTime = new Date('2024-01-01T10:00:00Z').getTime();

    const source = {
      start: new Date(baseTime).toISOString(),
      step: 15,
      // 0: 10:00, 1: 10:15, 2: 10:30, 3: 10:45, 4: 11:00
      values: [10, 20, 30, 40, 50],
    };

    it('extracts an exact matching window', () => {
      // Window: 10:00 to 11:15 (5 slots)
      const result = extractWindow(source, baseTime, baseTime + 5 * stepMs);
      expect(result).toEqual([10, 20, 30, 40, 50]);
    });

    it('extracts a subset (start offset)', () => {
      // Request 10:30 (index 2) to 11:00 (index 4 is 11:00, exclusive? logic says duration/step)
      // 10:30 to 11:00 is 2 slots: 10:30, 10:45
      const start = baseTime + 2 * stepMs; // 10:30
      const end = baseTime + 4 * stepMs;   // 11:00
      const result = extractWindow(source, start, end);
      expect(result).toEqual([30, 40]);
    });

    it('handles source starting AFTER target (pads start)', () => {
      // Request 09:45 to 10:30
      // 09:45 (pad), 10:00 (10), 10:15 (20)
      const start = baseTime - 1 * stepMs; // 09:45
      const end = baseTime + 2 * stepMs;   // 10:30
      const result = extractWindow(source, start, end);
      expect(result).toEqual([0, 10, 20]);
    });

    it('handles source ending BEFORE target (pads end)', () => {
      // Request 11:00 to 11:30
      // Source has 11:00 at index 4 (50).
      // Wait, 10:00 + 4*15 = 11:00. Index 4 is the slot STARTING at 11:00.
      // Source length 5 means we have slots starting at: 10:00, 10:15, 10:30, 10:45, 11:00.
      // So index 4 is valid for 11:00.

      // Let's ask for 11:00 to 11:45 (3 slots: 11:00, 11:15, 11:30)
      // Exists: 11:00 (50).
      // Missing: 11:15, 11:30.
      const start = baseTime + 4 * stepMs; // 11:00
      const end = baseTime + 7 * stepMs;   // 11:45
      const result = extractWindow(source, start, end);
      expect(result).toEqual([50, 0, 0]);
    });
  });
});
