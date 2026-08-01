import { describe, expect, it } from 'vitest';
import {
  validateOrigin,
  validateSettingsPatch,
  validateUserId,
} from '../../../src/background/validation';
import { DEFAULT_SETTINGS } from '../../../src/shared/constants';

describe('background input validation', () => {
  it('accepts only canonical HTTPS origins', () => {
    expect(validateOrigin('https://example.com')).toBe(true);
    expect(validateOrigin('https://example.com/path')).toBe(false);
    expect(validateOrigin('http://example.com')).toBe(false);
  });

  it('accepts only positive safe integer user IDs', () => {
    expect(validateUserId(1)).toBe(true);
    expect(validateUserId(0)).toBe(false);
    expect(validateUserId(1.2)).toBe(false);
    expect(validateUserId('1')).toBe(false);
  });

  it('requires a bounded window of at least five minutes', () => {
    expect(
      validateSettingsPatch(DEFAULT_SETTINGS, {
        windowStartMinutes: 540,
        windowEndMinutes: 600,
      }),
    ).toMatchObject({ windowStartMinutes: 540, windowEndMinutes: 600 });
    expect(
      validateSettingsPatch(DEFAULT_SETTINGS, {
        windowStartMinutes: 600,
        windowEndMinutes: 600,
      }),
    ).toBeUndefined();
  });
});
