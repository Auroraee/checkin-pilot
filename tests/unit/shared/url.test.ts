import { describe, expect, it } from 'vitest';
import {
  normalizeHttpsOrigin,
  originPermissionPattern,
} from '../../../src/shared/url';

describe('HTTPS origin handling', () => {
  it('reduces an HTTPS page URL to an exact origin', () => {
    expect(
      normalizeHttpsOrigin('https://runanytime.hxi.me/console/personal?q=1'),
    ).toBe('https://runanytime.hxi.me');
    expect(originPermissionPattern('https://runanytime.hxi.me')).toBe(
      'https://runanytime.hxi.me/*',
    );
  });

  it.each([
    'http://example.com',
    'https://user:pass@example.com',
    'chrome://extensions',
    'not a URL',
  ])('rejects unsafe input %s', (input) => {
    expect(normalizeHttpsOrigin(input)).toBeUndefined();
  });
});
