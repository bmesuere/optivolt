import { describe, it, expect } from 'vitest';
import { evWattsPerAmp, isEvConnection, EV_CONNECTIONS } from '../../lib/ev-connection.ts';

describe('evWattsPerAmp', () => {
  it('maps per-phase current to charge power for each connection', () => {
    expect(evWattsPerAmp('1x230')).toBe(230);
    expect(evWattsPerAmp('3x400')).toBe(690);
    expect(evWattsPerAmp('3x230')).toBeCloseTo(398.37, 2);
  });

  it('gives the familiar charger power levels', () => {
    expect(16 * evWattsPerAmp('3x400')).toBe(11040);           // "11 kW" wallbox
    expect(6 * evWattsPerAmp('3x400')).toBe(4140);             // three-phase minimum
    expect(16 * evWattsPerAmp('3x230')).toBeCloseTo(6374, 0);  // "6.4 kW" on a delta grid
  });

  it('falls back to single phase for missing or unknown values', () => {
    expect(evWattsPerAmp(undefined)).toBe(230);
    expect(evWattsPerAmp('2x230')).toBe(230);
  });

  it('recognizes exactly the supported connections', () => {
    for (const c of EV_CONNECTIONS) expect(isEvConnection(c)).toBe(true);
    expect(isEvConnection('3x415')).toBe(false);
    expect(isEvConnection(3)).toBe(false);
  });
});
