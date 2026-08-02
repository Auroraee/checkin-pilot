import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setOutcomeBadge } from '../../src/background/badge';
import { I18nProvider } from '../../src/ui/i18n';
import { PopupApp } from './PopupApp';
import '../../src/ui/base.css';
import './popup.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing popup root');

// Opening the popup acknowledges the last outcome badge on the toolbar icon.
void setOutcomeBadge();

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <PopupApp />
    </I18nProvider>
  </StrictMode>,
);
