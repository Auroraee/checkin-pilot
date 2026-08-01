import { describe, expect, it } from 'vitest';
import { minutesToTimeInput, timeInputToMinutes } from '../../../src/ui/format';

describe('time input formatting', () => {
  it('round trips valid browser-local schedule minutes', () => {
    expect(minutesToTimeInput(8 * 60)).toBe('08:00');
    expect(minutesToTimeInput(10 * 60 + 5)).toBe('10:05');
    expect(timeInputToMinutes('08:00')).toBe(480);
    expect(timeInputToMinutes('23:59')).toBe(1439);
  });

  it('rejects malformed or out-of-range input', () => {
    expect(timeInputToMinutes('24:00')).toBeUndefined();
    expect(timeInputToMinutes('09:60')).toBeUndefined();
    expect(timeInputToMinutes('9:00')).toBeUndefined();
  });
});
