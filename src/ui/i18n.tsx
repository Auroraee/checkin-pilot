import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import {
  normalizeUiLocale,
  translate,
  type TranslationKey,
  type UiLocale,
} from '../locales/translations';

interface I18nValue {
  locale: UiLocale;
  t: (key: TranslationKey, values?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | undefined>(undefined);

export function I18nProvider({ children }: { children: ReactNode }) {
  const value = useMemo<I18nValue>(() => {
    const locale = normalizeUiLocale(browser.i18n.getUILanguage());
    return {
      locale,
      t: (key, values) => translate(locale, key, values),
    };
  }, []);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');
  return context;
}
