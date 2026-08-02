import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Bell,
  CalendarDots,
  Check,
  Clock,
  GlobeHemisphereWest,
  ListChecks,
  ShieldCheck,
} from '@phosphor-icons/react';
import { browser } from 'wxt/browser';
import {
  AppHeader,
  Button,
  EmptyState,
  HistoryTable,
  InlineNotice,
  LoadingState,
  ScheduleCard,
  SectionHeading,
  SiteCard,
  StatusBadge,
  Switch,
} from '../../src/ui/components';
import { errorTranslationKey } from '../../src/ui/errors';
import { getSiteDisplayName, minutesToTimeInput, timeInputToMinutes } from '../../src/ui/format';
import { useI18n } from '../../src/ui/i18n';
import { useAppSnapshot } from '../../src/ui/useAppSnapshot';

export function OptionsApp() {
  const { t } = useI18n();
  const { snapshot, loading, errorCode: snapshotError, request } = useAppSnapshot();
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('10:00');
  const [notifyOnSuccess, setNotifyOnSuccess] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string }>();
  const [validationError, setValidationError] = useState<string>();
  // chrome://extensions embeds this page in an iframe where window.confirm()
  // is silently blocked, so removal confirmation must live in the page itself.
  const [removeCandidate, setRemoveCandidate] = useState<string>();

  useEffect(() => {
    if (!snapshot) return;
    setStartTime(minutesToTimeInput(snapshot.settings.windowStartMinutes));
    setEndTime(minutesToTimeInput(snapshot.settings.windowEndMinutes));
    setNotifyOnSuccess(snapshot.settings.notifyOnSuccess);
  }, [snapshot?.settings]);

  const records = useMemo(
    () => snapshot ? [...snapshot.records].sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt)) : [],
    [snapshot?.records],
  );
  // Card-level busy is scoped per origin; only the settings save freezes every card.
  const globalBusy = busy === 'settings';

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    const windowStartMinutes = timeInputToMinutes(startTime);
    const windowEndMinutes = timeInputToMinutes(endTime);
    if (
      windowStartMinutes === undefined ||
      windowEndMinutes === undefined ||
      windowEndMinutes <= windowStartMinutes
    ) {
      setValidationError(t('validationWindow'));
      return;
    }

    setValidationError(undefined);
    setNotice(undefined);
    setBusy('settings');
    const response = await request({
      type: 'settings:update',
      patch: { windowStartMinutes, windowEndMinutes },
    });
    if (response.ok) {
      setNotice({ tone: 'success', text: t('saved') });
    } else {
      setNotice({ tone: 'danger', text: t(errorTranslationKey(response.errorCode)) });
    }
    setBusy(undefined);
  };

  const toggleNotifyOnSuccess = async (checked: boolean) => {
    setNotifyOnSuccess(checked);
    setNotice(undefined);
    const response = await request({ type: 'settings:update', patch: { notifyOnSuccess: checked } });
    if (!response.ok) {
      setNotifyOnSuccess(!checked);
      setNotice({ tone: 'danger', text: t(errorTranslationKey(response.errorCode)) });
    }
  };

  const toggleSite = async (origin: string, enabled: boolean) => {
    setBusy(`toggle:${origin}`);
    setNotice(undefined);
    const response = await request({ type: 'site:set-enabled', origin, enabled });
    if (!response.ok) {
      setNotice({ tone: 'danger', text: t(errorTranslationKey(response.errorCode)) });
    }
    setBusy(undefined);
  };

  const manualCheck = async (origin: string) => {
    setBusy(`manual:${origin}`);
    setNotice(undefined);
    const response = await request({ type: 'site:manual-checkin', origin });
    if (!response.ok) {
      setNotice({ tone: 'danger', text: t(errorTranslationKey(response.errorCode)) });
    } else if (response.type === 'checkin') {
      const successful = response.outcome.code === 'success' || response.outcome.code === 'already_checked';
      setNotice({
        tone: successful ? 'success' : response.outcome.code === 'action_required' ? 'warning' : 'danger',
        text: successful
          ? response.outcome.code === 'already_checked' ? t('alreadyChecked') : t('success')
          : response.outcome.code === 'action_required'
            ? t('challengeRequired')
            : t(errorTranslationKey(response.outcome.errorCode)),
      });
    }
    setBusy(undefined);
  };

  const removeSite = async (origin: string) => {
    setRemoveCandidate(undefined);
    setBusy(`remove:${origin}`);
    setNotice(undefined);
    const response = await request({ type: 'site:remove', origin });
    if (response.ok) {
      setNotice({ tone: 'success', text: t('siteRemoved') });
    } else {
      setNotice({ tone: 'danger', text: t(errorTranslationKey(response.errorCode)) });
    }
    setBusy(undefined);
  };

  return (
    <main className="options-shell">
      <div className="options-header-row">
        <AppHeader />
        <StatusBadge tone="success">{t('localOnly')}</StatusBadge>
      </div>

      <div className="options-title">
        <div>
          <h1>{t('options')}</h1>
          <p>{t('optionsDescription')}</p>
        </div>
        {snapshot ? (
          <ScheduleCard
            nextBatchAt={snapshot.nextBatchAt}
            state={snapshot.currentSchedule?.state}
          />
        ) : null}
      </div>

      {loading ? <LoadingState /> : snapshot ? (
        <div className="options-content">
          {notice ? <InlineNotice tone={notice.tone}>{notice.text}</InlineNotice> : null}
          {snapshotError ? <InlineNotice tone="danger">{t(errorTranslationKey(snapshotError))}</InlineNotice> : null}

          <section className="settings-section" aria-labelledby="daily-window-title">
            <SectionHeading
              id="daily-window-title"
              title={t('currentWindow')}
              description={t('browserLocalTime')}
              action={<CalendarDots size={23} weight="duotone" aria-hidden="true" />}
            />
            <form className="settings-card" onSubmit={(event) => void saveSettings(event)}>
              <div className="time-fields">
                <label>
                  <span>{t('windowStart')}</span>
                  <span className="time-input-wrap"><Clock size={17} aria-hidden="true" /><input type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} required /></span>
                </label>
                <label>
                  <span>{t('windowEnd')}</span>
                  <span className="time-input-wrap"><Clock size={17} aria-hidden="true" /><input type="time" value={endTime} onChange={(event) => setEndTime(event.target.value)} required /></span>
                </label>
              </div>

              <div className="settings-divider" />

              <div className="notification-settings">
                <div className="setting-row">
                  <div className="setting-icon" aria-hidden="true"><Bell size={19} weight="fill" /></div>
                  <div><strong>{t('notifications')}</strong><span>{t('notifyActionOnly')}</span></div>
                </div>
                <div className="setting-row setting-row-nested">
                  <div />
                  <div><strong>{t('notifyOnSuccess')}</strong></div>
                  <Switch checked={notifyOnSuccess} onChange={(checked) => void toggleNotifyOnSuccess(checked)} label={t('notifyOnSuccess')} />
                </div>
              </div>

              {validationError ? <p className="field-error" role="alert">{validationError}</p> : null}
              <div className="settings-actions">
                <Button variant="primary" icon={<Check size={17} weight="bold" />} type="submit" disabled={busy === 'settings'}>
                  {busy === 'settings' ? t('running') : t('save')}
                </Button>
              </div>
            </form>
          </section>

          <section className="settings-section" aria-labelledby="manage-sites-title">
            <SectionHeading
              id="manage-sites-title"
              title={t('manageSites')}
              description={t('pausedHint')}
              action={<GlobeHemisphereWest size={23} weight="duotone" aria-hidden="true" />}
            />
            {snapshot.sites.length ? (
              <div className="options-site-grid">
                {snapshot.sites.map((site) => (
                  <div key={site.origin} className="site-card-slot">
                    <SiteCard
                      site={site}
                      running={snapshot.runningOrigins.includes(site.origin)}
                      busy={globalBusy || Boolean(busy?.endsWith(site.origin))}
                      onToggle={(enabled) => void toggleSite(site.origin, enabled)}
                      onManual={() => void manualCheck(site.origin)}
                      onOpen={() => void browser.tabs.create({ url: site.origin })}
                      onRemove={() => setRemoveCandidate(site.origin)}
                    />
                    {removeCandidate === site.origin ? (
                      <InlineNotice tone="danger" title={t('remove')}>
                        {t('confirmRemove', { site: getSiteDisplayName(site) })}
                        <div className="settings-actions">
                          <Button variant="ghost" onClick={() => setRemoveCandidate(undefined)} disabled={Boolean(busy)}>
                            {t('cancel')}
                          </Button>
                          <Button
                            variant="danger"
                            onClick={() => void removeSite(site.origin)}
                            disabled={Boolean(busy)}
                          >
                            {t('remove')}
                          </Button>
                        </div>
                      </InlineNotice>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="settings-card">
                <EmptyState
                  title={t('emptySites')}
                  description={t('emptySitesHint')}
                  icon={<GlobeHemisphereWest size={24} weight="duotone" />}
                />
              </div>
            )}
          </section>

          <section className="settings-section" aria-labelledby="history-title">
            <SectionHeading
              id="history-title"
              title={t('history')}
              description={t('historyDescription')}
              action={<ListChecks size={23} weight="duotone" aria-hidden="true" />}
            />
            {records.length ? (
              <HistoryTable records={records} sites={snapshot.sites} />
            ) : (
              <div className="settings-card">
                <EmptyState
                  title={t('emptyHistory')}
                  description={t('emptyHistoryHint')}
                  icon={<ListChecks size={24} weight="duotone" />}
                />
              </div>
            )}
          </section>

          <footer className="options-footer">
            <ShieldCheck size={16} weight="fill" aria-hidden="true" />
            <span>{t('localOnly')}</span>
          </footer>
        </div>
      ) : (
        <InlineNotice tone="danger" title={t('error')}>
          {t(errorTranslationKey(snapshotError))}
        </InlineNotice>
      )}
    </main>
  );
}
