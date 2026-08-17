import { describe, it, expect } from 'vitest';
import { supportsTypeStripping } from '../../scripts/check-node-version.mjs';

describe('supportsTypeStripping', () => {
  it.each([
    ['v20.10.0', false],
    ['v22.17.0', false],
    ['v22.18.0', true],
    ['v22.99.0', true],
    ['v23.0.0', false],
    ['v23.5.0', false],
    ['v23.6.0', true],
    ['v24.0.0', true],
  ])('%s -> %s', (version, expected) => {
    expect(supportsTypeStripping(version)).toBe(expected);
  });
});
