import { describe, expect, it } from 'vitest';
import { en, normalizeUiLocale, translate, zhCN } from '../../../src/locales/translations';

describe('UI translations', () => {
  it('follows English Chrome locales and falls back to Simplified Chinese', () => {
    expect(normalizeUiLocale('en-US')).toBe('en');
    expect(normalizeUiLocale('en-GB')).toBe('en');
    expect(normalizeUiLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeUiLocale('fr-FR')).toBe('zh-CN');
    expect(normalizeUiLocale(undefined)).toBe('zh-CN');
  });

  it('interpolates only named display values', () => {
    expect(translate('en', 'toggleSite', { site: 'example.com' })).toBe(
      'Toggle automatic check-in for example.com',
    );
    expect(translate('zh-CN', 'currentAccount')).toBe('当前账号编号');
  });

  it('contains no visible em dash or en dash characters', () => {
    for (const value of [...Object.values(zhCN), ...Object.values(en)]) {
      expect(value).not.toMatch(/[\u2013\u2014]/u);
    }
  });
});
