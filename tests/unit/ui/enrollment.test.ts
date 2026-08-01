import { describe, expect, it } from 'vitest';
import { exactOriginPattern } from '../../../src/ui/enrollment';

describe('site permission origin patterns', () => {
  it('reduces an HTTPS page URL to one exact origin', () => {
    expect(exactOriginPattern('https://runanytime.hxi.me/console/personal?tab=1')).toBe(
      'https://runanytime.hxi.me/*',
    );
    expect(exactOriginPattern('https://example.com:8443/path')).toBe(
      'https://example.com:8443/*',
    );
  });

  it('rejects HTTP, extension, and malformed URLs', () => {
    expect(exactOriginPattern('http://example.com/')).toBeUndefined();
    expect(exactOriginPattern('chrome-extension://abc/options.html')).toBeUndefined();
    expect(exactOriginPattern('not a URL')).toBeUndefined();
  });
});
