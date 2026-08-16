import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle,
  GearSix,
  GlobeHemisphereWest,
  PlayCircle,
  Plus,
  ShieldCheck,
} from '@phosphor-icons/react';
import { browser } from 'wxt/browser';
import type { ProbeReport, SiteView } from '../../src/shared/domain';
import type { EnrollmentConfirmation } from '../../src/shared/messages';
import {
  AppHeader,
  Button,
  EmptyState,
  IconButton,
  InlineNotice,
  LoadingState,
  ScheduleCard,
  SiteCard,
  StatusBadge,
} from '../../src/ui/components';
import { errorTranslationKey } from '../../src/ui/errors';
import {
  inspectActiveTab,
  readTabIdentity,
  revokeOrigin,
  EnrollmentError,
  type ActiveTabPage,
  type EnrollmentPage,
} from '../../src/ui/enrollment';
import {
  clearPendingEnrollment,
  readPendingEnrollment,
  writePendingEnrollment,
} from '../../src/shared/pending-enrollment';
import { useAppSnapshot } from '../../src/ui/useAppSnapshot';
import { useI18n } from '../../src/ui/i18n';

type PendingEnrollment =
  | {
      kind: 'rebind';
      page: EnrollmentPage;
      existing: SiteView;
      authMode?: EnrollmentConfirmation['authMode'];
      adapterId?: EnrollmentConfirmation['adapterId'];
      platform?: EnrollmentConfirmation['platform'];
      supportLevel?: EnrollmentConfirmation['supportLevel'];
      capabilities?: EnrollmentConfirmation['capabilities'];
    }
  | { kind: 'visit'; tab: ActiveTabPage };

type BusyAction = 'probe' | 'confirm' | 'batch' | string;

function pendingOrigin(pending: PendingEnrollment): string {
  return pending.kind === 'rebind' ? pending.page.origin : pending.tab.origin;
}

function enrollmentFromReport(
  tab: ActiveTabPage,
  report: ProbeReport,
): EnrollmentConfirmation {
  if (
    !report.adapterId ||
    !report.platform ||
    !report.authMode ||
    !report.supportLevel ||
    !report.capabilities ||
    !(report.userId > 0)
  ) {
    throw new Error('invalid_probe_response');
  }
  return {
    origin: tab.origin,
    label: tab.label,
    userId: report.userId,
    identitySource: report.identitySource,
    adapterId: report.adapterId,
    platform: report.platform,
    authMode: report.authMode,
    supportLevel: report.supportLevel,
    capabilities: report.capabilities,
  };
}

export function PopupApp() {
  const { t } = useI18n();
  const { snapshot, loading, errorCode: snapshotError, request } = useAppSnapshot();
  const [busy, setBusy] = useState<BusyAction>();
  const [pending, setPending] = useState<PendingEnrollment>();
  const [message, setMessage] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string }>();
  const [activeOrigin, setActiveOrigin] = useState<string>();
  const resumedRef = useRef(false);

  // Picks up an enrollment interrupted by the permission dialog: either the
  // background already finished it, or it left a visit-mode offer to show.
  useEffect(() => {
    if (!snapshot || resumedRef.current) return;
    resumedRef.current = true;
    void (async () => {
      const marker = await readPendingEnrollment();
      if (!marker) return;
      if (snapshot.sites.some((site) => site.origin === marker.origin)) {
        await clearPendingEnrollment();
        setMessage({ tone: 'success', text: t('siteAdded') });
        return;
      }
      if (marker.state === 'visit-offer') {
        await clearPendingEnrollment();
        setPending({
          kind: 'visit',
          tab: {
            tabId: marker.tabId,
            origin: marker.origin,
            originPattern: `${marker.origin}/*`,
            label: marker.label,
          },
        });
      }
    })();
  }, [snapshot, t]);

  // The primary button is renamed to "Update current site" when the active
  // tab already belongs to a configured site (the update entry point).
  useEffect(() => {
    void (async () => {
      try {
        const tab = await inspectActiveTab();
        setActiveOrigin(tab.origin);
      } catch {
        setActiveOrigin(undefined);
      }
    })();
  }, []);

  const clearMessage = () => setMessage(undefined);

  const addCurrentSite = async () => {
    setBusy('probe');
    setPending(undefined);
    clearMessage();
    let tab: ActiveTabPage | undefined;
    try {
      tab = await inspectActiveTab();
      const existing = snapshot?.sites.find((site) => site.origin === tab?.origin);

      let page: EnrollmentPage | undefined;
      try {
        // If the permission dialog closes this popup, the background resumes
        // the flow from this marker; a surviving popup reclaims it right after.
        await writePendingEnrollment({
          origin: tab.origin,
          label: tab.label,
          tabId: tab.tabId,
          state: 'awaiting-permission',
          createdAt: Date.now(),
        });
        page = await readTabIdentity(tab);
        await clearPendingEnrollment();
      } catch (identityError) {
        await clearPendingEnrollment();
        // A signed-in page without a readable account number can still probe
        // through the modern refresh flow (the account comes from the token
        // refresh); only the legacy fallback needs the MAIN-world identity.
        if (
          !(
            identityError instanceof EnrollmentError &&
            (identityError.code === 'identity_missing' || identityError.code === 'script_failed')
          )
        ) {
          throw identityError;
        }
      }

      const response = await request({
        type: 'site:probe',
        origin: tab.origin,
        ...(page ? { userId: page.userId, identitySource: page.identitySource } : {}),
      });
      if (!response.ok) throw new Error(response.errorCode);
      if (response.type !== 'probe') throw new Error('invalid_probe_response');

      const report = response.report;
      if (!report.supported) {
        if (report.reason === 'sign_in') {
          // 401 means "sign in", never "incompatible".
          setMessage({ tone: 'warning', text: t('errorAuth') });
          return;
        }
        if (report.reason === 'identity_missing') {
          setMessage({ tone: 'warning', text: t('errorIdentity') });
          return;
        }
        if (existing) {
          setMessage({ tone: 'warning', text: t('unsupportedDetails') });
          return;
        }
        // Unsupported protocol or an unknown private challenge: the user may
        // pick the visit access mode instead.
        setPending({ kind: 'visit', tab });
        return;
      }

      if (existing) {
        if (existing.binding.userId === report.userId) {
          const upgrade = await request({
            type: 'site:upgrade',
            enrollment: enrollmentFromReport(tab, report),
          });
          if (!upgrade.ok) throw new Error(upgrade.errorCode);
          setMessage({ tone: 'success', text: t('siteUpdated') });
        } else {
          // The signed-in account changed; a separately confirmed rebind is
          // required, carrying the newly detected auth fields.
          setPending({
            kind: 'rebind',
            page: {
              origin: tab.origin,
              originPattern: tab.originPattern,
              label: tab.label,
              userId: report.userId,
              identitySource: report.identitySource,
            },
            existing,
            ...(report.authMode ? { authMode: report.authMode } : {}),
            ...(report.adapterId ? { adapterId: report.adapterId } : {}),
            ...(report.platform ? { platform: report.platform } : {}),
            ...(report.supportLevel ? { supportLevel: report.supportLevel } : {}),
            ...(report.capabilities ? { capabilities: report.capabilities } : {}),
          });
        }
        return;
      }

      const confirm = await request({
        type: 'site:confirm',
        enrollment: enrollmentFromReport(tab, report),
      });
      if (!confirm.ok) throw new Error(confirm.errorCode);
      setMessage({ tone: 'success', text: t('siteAdded') });
    } catch (error) {
      if (tab && !snapshot?.sites.some((site) => site.origin === tab?.origin)) {
        await revokeOrigin(tab.origin);
      }
      setMessage({ tone: 'danger', text: t(errorTranslationKey(error)) });
    } finally {
      setBusy(undefined);
    }
  };

  const cancelEnrollment = async () => {
    if (pending && !snapshot?.sites.some((site) => site.origin === pendingOrigin(pending))) {
      await revokeOrigin(pendingOrigin(pending));
    }
    setPending(undefined);
  };

  const confirmEnrollment = async () => {
    if (!pending) return;
    setBusy('confirm');
    clearMessage();
    try {
      if (pending.kind === 'rebind') {
        const response = await request({
          type: 'site:rebind',
          origin: pending.page.origin,
          userId: pending.page.userId,
          identitySource: pending.page.identitySource,
          ...(pending.authMode ? { authMode: pending.authMode } : {}),
          ...(pending.adapterId ? { adapterId: pending.adapterId } : {}),
          ...(pending.platform ? { platform: pending.platform } : {}),
          ...(pending.supportLevel ? { supportLevel: pending.supportLevel } : {}),
          ...(pending.capabilities ? { capabilities: pending.capabilities } : {}),
        });
        if (!response.ok) throw new Error(response.errorCode);
      } else {
        const enrollment: EnrollmentConfirmation = {
          origin: pending.tab.origin,
          label: pending.tab.label,
          userId: 1,
          identitySource: 'uid',
          adapterId: 'visit-open',
          platform: 'generic',
          authMode: 'none',
          supportLevel: 'detected',
          capabilities: { checkin: true, statusEndpoint: false },
        };
        const response = await request({ type: 'site:confirm', enrollment });
        if (!response.ok) throw new Error(response.errorCode);
      }
      setMessage({ tone: 'success', text: t('siteAdded') });
      setPending(undefined);
    } catch (error) {
      setMessage({ tone: 'danger', text: t(errorTranslationKey(error)) });
    } finally {
      setBusy(undefined);
    }
  };

  const runAll = async () => {
    setBusy('batch');
    clearMessage();
    const response = await request({ type: 'batch:run-all' });
    if (!response.ok) {
      setMessage({ tone: 'danger', text: t(errorTranslationKey(response.errorCode)) });
    }
    setBusy(undefined);
  };

  const toggleSite = async (origin: string, enabled: boolean) => {
    setBusy(`toggle:${origin}`);
    clearMessage();
    const response = await request({ type: 'site:set-enabled', origin, enabled });
    if (!response.ok) {
      setMessage({ tone: 'danger', text: t(errorTranslationKey(response.errorCode)) });
    }
    setBusy(undefined);
  };

  const manualCheck = async (origin: string) => {
    setBusy(`manual:${origin}`);
    clearMessage();
    const response = await request({ type: 'site:manual-checkin', origin });
    if (!response.ok) {
      setMessage({ tone: 'danger', text: t(errorTranslationKey(response.errorCode)) });
    } else if (response.type === 'checkin') {
      const tone = response.outcome.code === 'success' || response.outcome.code === 'already_checked'
        ? 'success'
        : response.outcome.code === 'action_required'
          ? 'warning'
          : response.outcome.code === 'unverified'
            ? 'warning'
            : 'danger';
      const text = response.outcome.code === 'success'
        ? t('success')
        : response.outcome.code === 'already_checked'
          ? t('alreadyChecked')
          : response.outcome.code === 'action_required'
            ? t('challengeRequired')
            : response.outcome.code === 'unverified'
              ? t('statusUnverified')
              : t(errorTranslationKey(response.outcome.errorCode));
      setMessage({ tone, text });
    }
    setBusy(undefined);
  };

  const enabledCount = snapshot?.sites.filter((site) => site.enabled).length ?? 0;
  // Card-level busy is scoped per origin; only probe/confirm/batch freeze every card.
  const globalBusy = busy === 'probe' || busy === 'confirm' || busy === 'batch';
  const onSitePage = Boolean(activeOrigin && snapshot?.sites.some((site) => site.origin === activeOrigin));

  return (
    <main className="popup-shell">
      <AppHeader
        trailing={
          <IconButton label={t('openOptions')} onClick={() => void browser.runtime.openOptionsPage()}>
            <GearSix size={19} />
          </IconButton>
        }
      />

      {loading ? <LoadingState /> : snapshot ? (
        <>
          <div className="primary-actions">
            <Button
              variant="primary"
              icon={<Plus size={17} weight="bold" />}
              onClick={() => void addCurrentSite()}
              disabled={Boolean(busy)}
            >
              {busy === 'probe' ? t('probing') : onSitePage ? t('updateCurrentSite') : t('addCurrentSite')}
            </Button>
            <Button
              variant="secondary"
              icon={<PlayCircle size={18} weight="fill" />}
              onClick={() => void runAll()}
              disabled={Boolean(busy) || enabledCount === 0}
            >
              {busy === 'batch' ? t('running') : t('runAllShort')}
            </Button>
          </div>
          <p className="auth-boundary-hint">{t('authBoundaryHint')}</p>

          <ScheduleCard
            nextBatchAt={snapshot.nextBatchAt}
            state={snapshot.currentSchedule?.state}
          />

          {message ? (
            <InlineNotice tone={message.tone}>{message.text}</InlineNotice>
          ) : snapshotError ? (
            <InlineNotice tone="danger">{t(errorTranslationKey(snapshotError))}</InlineNotice>
          ) : null}

          {pending ? (
            <section className="probe-panel" aria-labelledby="probe-title">
              <div className="probe-heading">
                <div className="probe-icon" aria-hidden="true"><ShieldCheck size={22} weight="fill" /></div>
                <div>
                  <strong id="probe-title">
                    {pending.kind === 'visit' ? t('visitModeAvailable') : t('detectedSite')}
                  </strong>
                  <span>{pendingOrigin(pending)}</span>
                </div>
                <StatusBadge tone={pending.kind === 'visit' ? 'accent' : 'success'}>
                  {pending.kind === 'visit' ? t('visitModeBadge') : t('ready')}
                </StatusBadge>
              </div>
              {pending.kind === 'rebind' ? (
                <dl className="probe-details">
                  <div><dt>{t('currentAccount')}</dt><dd>{pending.page.userId}</dd></div>
                  <div><dt>{t('identitySource')}</dt><dd>{pending.page.identitySource}</dd></div>
                </dl>
              ) : null}
              <p>
                {pending.kind === 'visit' ? t('visitModeDescription') : t('confirmAddDescription')}
              </p>
              <div className="probe-actions">
                <Button variant="ghost" onClick={() => void cancelEnrollment()} disabled={busy === 'confirm'}>
                  {t('cancel')}
                </Button>
                <Button
                  variant="primary"
                  icon={<CheckCircle size={17} weight="fill" />}
                  onClick={() => void confirmEnrollment()}
                  disabled={busy === 'confirm'}
                >
                  {pending.kind === 'rebind' ? t('confirmRebind') : t('confirmAddVisit')}
                </Button>
              </div>
            </section>
          ) : null}

          <section className="site-list-section" aria-labelledby="site-list-title">
            <div className="compact-heading">
              <h2 id="site-list-title">{t('sites')}</h2>
              <span>{snapshot.sites.length}</span>
            </div>
            {snapshot.sites.length ? (
              <div className="site-list">
                {snapshot.sites.map((site) => (
                  <SiteCard
                    key={site.origin}
                    site={site}
                    running={snapshot.runningOrigins.includes(site.origin)}
                    busy={globalBusy || Boolean(busy?.endsWith(site.origin))}
                    onToggle={(enabled) => void toggleSite(site.origin, enabled)}
                    onManual={() => void manualCheck(site.origin)}
                    onOpen={() => void browser.tabs.create({ url: site.origin })}
                  />
                ))}
              </div>
            ) : (
              <EmptyState
                title={t('emptySites')}
                description={t('emptySitesHint')}
                icon={<GlobeHemisphereWest size={23} weight="duotone" />}
              />
            )}
          </section>

          <footer className="popup-footer">
            <ShieldCheck size={15} aria-hidden="true" />
            <span>{t('localOnly')}</span>
          </footer>
        </>
      ) : (
        <InlineNotice tone="danger" title={t('error')}>
          {t(errorTranslationKey(snapshotError))}
        </InlineNotice>
      )}
    </main>
  );
}
