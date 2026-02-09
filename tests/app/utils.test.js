import { describe, it, expect, vi } from 'vitest';
import { debounce } from '../../app/scr/utils.js';

describe('debounce', () => {
  it('executes the function after the delay', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(51);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('resets the timer on subsequent calls', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    vi.advanceTimersByTime(50);
    debounced(); // reset
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(51);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('cancels the execution', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced();
    debounced.cancel();
    vi.advanceTimersByTime(101);
    expect(fn).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
