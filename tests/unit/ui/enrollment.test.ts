import { describe, expect, it } from 'vitest';
import { exactOriginPattern, siteLabelFromTabTitle } from '../../../src/ui/enrollment';

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

describe('site label from tab title', () => {
  it('uses the page title as the site label', () => {
    expect(siteLabelFromTabTitle('RunAnytime 控制台', 'runanytime.hxi.me')).toBe(
      'RunAnytime 控制台',
    );
  });

  it('collapses whitespace and strips control characters', () => {
    expect(siteLabelFromTabTitle('  Example\t\u0007Site \n ', 'example.com')).toBe(
      'Example Site',
    );
  });

  it('truncates over-long titles to the enrollment-label limit', () => {
    expect(siteLabelFromTabTitle('x'.repeat(150), 'example.com')).toHaveLength(120);
  });

  it('falls back to the hostname when the title is missing or blank', () => {
    expect(siteLabelFromTabTitle(undefined, 'example.com')).toBe('example.com');
    expect(siteLabelFromTabTitle('   ', 'example.com')).toBe('example.com');
  });
});
