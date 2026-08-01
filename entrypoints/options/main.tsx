import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/ui/i18n';
import { OptionsApp } from './OptionsApp';
import '../../src/ui/base.css';
import './options.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing options root');

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <OptionsApp />
    </I18nProvider>
  </StrictMode>,
);
