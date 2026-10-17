import { useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import {
  AirplaneTakeoff,
  ArrowSquareOut,
  BellRinging,
  CheckCircle,
  Clock,
  PauseCircle,
  Play,
  Trash,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react';
import type { CheckinRecord, SiteView, TodaySummary, TodayStatus } from '../shared/domain';
import type { TranslationKey } from '../locales/translations';
import { recoveryForSite } from './recovery';
import { originPermissionPattern } from '../shared/url';
import { errorTranslationKey } from './errors';
import { useI18n } from './i18n';
import {
  actionReasonTranslationKey,
  formatDateTime,
  formatDuration,
  getSiteDisplayName,
  recordOutcomeTranslationKey,
  recordTone,
} from './format';

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'accent';

export function AppHeader({ trailing }: { trailing?: ReactNode }) {
  const { t } = useI18n();
  return (
    <header className="app-header">
      <div className="brand-mark" aria-hidden="true">
        <AirplaneTakeoff weight="fill" size={20} />
      </div>
      <div className="brand-copy">
        <strong>{t('appName')}</strong>
      </div>
      {trailing ? <div className="header-trailing">{trailing}</div> : null}
    </header>
  );
}

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  icon?: ReactNode;
}

export function Button({
  variant = 'secondary',
  icon,
  className = '',
  children,
  ...props
}: ButtonProps) {
  return (
    <button className={`button button-${variant} ${className}`.trim()} {...props}>
      {icon ? <span className="button-icon" aria-hidden="true">{icon}</span> : null}
      <span>{children}</span>
    </button>
  );
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  tone?: 'default' | 'danger';
}

export function IconButton({ label, tone = 'default', className = '', children, ...props }: IconButtonProps) {
  return (
    <button
      className={`icon-button icon-button-${tone} ${className}`.trim()}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon = tone === 'success'
    ? CheckCircle
    : tone === 'warning'
      ? WarningCircle
      : tone === 'danger'
        ? XCircle
        : tone === 'accent'
          ? Clock
          : PauseCircle;
  return (
    <span className={`status-badge status-${tone}`}>
      <Icon size={14} weight="fill" aria-hidden="true" />
      {children}
    </span>
  );
}

export function InlineNotice({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  const Icon = tone === 'success'
    ? CheckCircle
    : tone === 'danger'
      ? XCircle
      : tone === 'warning'
        ? WarningCircle
        : BellRinging;
  return (
    <div className={`notice notice-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon size={19} weight="fill" aria-hidden="true" />
      <div>
        {title ? <strong>{title}</strong> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function LoadingState() {
  const { t } = useI18n();
  return (
    <div className="loading-state" aria-live="polite" aria-busy="true">
      <span className="spinner" aria-hidden="true" />
      <span>{t('loading')}</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-icon" aria-hidden="true">{icon}</div> : null}
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <label className="switch-control" title={label}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
        disabled={disabled}
      />
      <span className="switch-track" aria-hidden="true"><span /></span>
    </label>
  );
}

function siteStatus(site: SiteView, running: boolean) {
  if (running) return { key: 'running' as const, tone: 'accent' as Tone };
  if (site.binding.state === 'action_required') {
    return {
      key: actionReasonTranslationKey(site.binding.actionReason),
      tone: 'warning' as Tone,
    };
  }
  if (!site.enabled) return { key: 'disabled' as const, tone: 'neutral' as Tone };
  if (site.today) {
    const status = site.today.status;
    if (status === 'attention' && site.today.record) {
      return { key: recordOutcomeTranslationKey(site.today.record), tone: 'warning' as Tone };
    }
    return { key: todayStatusKeys[status], tone: todayStatusTone(status) };
  }
  if (!site.latestRecord) return { key: 'statusReady' as const, tone: 'neutral' as Tone };
  return {
    key: recordOutcomeTranslationKey(site.latestRecord),
    tone: recordTone(site.latestRecord) as Tone,
  };
}

export function SiteCard({
  site,
  running = false,
  busy = false,
  onToggle,
  onManual,
  onOpen,
  onRemove,
  onUpdate,
}: {
  site: SiteView;
  running?: boolean;
  busy?: boolean;
  onToggle: (enabled: boolean) => void;
  onManual: () => void;
  onOpen: () => void;
  onRemove?: () => void;
  onUpdate?: () => void;
}) {
  const { locale, t } = useI18n();
  const displayName = getSiteDisplayName(site);
  const status = siteStatus(site, running);
  const recovery = recoveryForSite(site);
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<TranslationKey>();
  const retry = site.today?.retry;
  const retryDue = retry && Date.parse(retry.dueAt) <= Date.now();

  const recover = async () => {
    setRecoveryError(undefined);
    if (recovery?.kind === 'permission') {
      setRecovering(true);
      try {
        // Keep the permission request directly in the click's user gesture.
        const granted = await browser.permissions.request({ origins: [originPermissionPattern(site.origin)] });
        if (granted) onManual();
        else setRecoveryError('errorPermission');
      } catch {
        setRecoveryError('errorPermission');
      } finally {
        setRecovering(false);
      }
    } else if (recovery?.kind === 'update') {
      (onUpdate ?? onOpen)();
    } else {
      onOpen();
    }
  };

  return (
    <article className="site-card">
      <div className="site-card-main">
        <div className="site-identity">
          <div className="site-heading">
            <strong title={site.origin}>{displayName}</strong>
            <StatusBadge tone={status.tone}>{t(status.key)}</StatusBadge>
          </div>
          <div className="site-subline">
            <span className="site-origin" title={site.origin}>{site.origin}</span>
            <span className="site-meta">
              {site.latestRecord
                ? `${t('lastResult')}: ${formatDateTime(locale, site.latestRecord.attemptedAt)}`
                : t('never')}
            </span>
          </div>
        </div>
        <Switch
          checked={site.enabled}
          onChange={onToggle}
          label={t('toggleSite', { site: displayName })}
          disabled={busy}
        />
      </div>
      {retry ? (
        <p className="site-detail" role="status">
          {retryDue ? t('retryDue') : t('retryAt', { time: formatDateTime(locale, retry.dueAt) })}
          {' · '}{t('retryRemaining', { count: retry.remaining })}
        </p>
      ) : null}
      {recovery ? <p className="site-detail">{t(recovery.hint)}</p> : null}
      {site.today?.record?.errorCode && !running ? (
        <p className="site-detail">{t(errorTranslationKey(site.today.record.errorCode))}</p>
      ) : null}
      {recoveryError ? <p className="site-detail site-detail-error" role="alert">{t(recoveryError)}</p> : null}
      <div className="site-actions">
        {recovery && recovery.kind !== 'retry' ? (
          <Button onClick={() => void recover()} disabled={busy || running || recovering}>
            {t(recovery.label)}
          </Button>
        ) : null}
        <Button
          variant="secondary"
          icon={<Play size={16} weight="fill" />}
          onClick={onManual}
          disabled={busy || running || recovering}
        >
          {running ? t('checking') : recovery ? t('recoverCheck') : t('manualCheck')}
        </Button>
        <IconButton label={t('openSite')} onClick={onOpen} disabled={busy}>
          <ArrowSquareOut size={18} />
        </IconButton>
        {onRemove ? (
          <IconButton label={t('remove')} tone="danger" onClick={onRemove} disabled={busy}>
            <Trash size={18} />
          </IconButton>
        ) : null}
      </div>
    </article>
  );
}

export function ScheduleCard({
  nextBatchAt,
  state,
  retrying = 0,
}: {
  nextBatchAt: string | undefined;
  state: 'scheduled' | 'running' | 'complete' | undefined;
  retrying?: number;
}) {
  const { locale, t } = useI18n();
  const statusKey = state === 'running'
    ? 'scheduleRunning'
    : retrying > 0
      ? 'scheduleRetrying'
      : state === 'complete'
        ? 'scheduleComplete'
        : 'schedulePending';
  return (
    <section className="schedule-card" aria-label={t('nextWindow')}>
      <div className="schedule-icon" aria-hidden="true"><Clock size={21} weight="fill" /></div>
      <div>
        <span className="eyebrow">{t('nextWindow')}</span>
        <strong>{nextBatchAt ? formatDateTime(locale, nextBatchAt) : t(statusKey)}</strong>
        {nextBatchAt ? <small>{t(statusKey)}</small> : null}
      </div>
    </section>
  );
}

const todayStatusKeys: Record<TodayStatus, TranslationKey> = {
  completed: 'done', retrying: 'statusRetrying', attention: 'statusActionRequired',
  failed: 'statusFailed', unverified: 'statusUnverified', pending: 'todayPending',
  running: 'running', paused: 'disabled',
};

function todayStatusTone(status: TodayStatus): Tone {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'attention') return 'warning';
  if (status === 'retrying' || status === 'running') return 'accent';
  return 'neutral';
}

export function TodayOverview({ summary }: { summary: TodaySummary }) {
  const { t } = useI18n();
  const statuses: TodayStatus[] = ['running', 'retrying', 'attention', 'failed', 'unverified', 'pending', 'paused'];
  return (
    <section className="today-overview" aria-label={t('todayOverview')} aria-live="polite">
      <div className="today-heading">
        <strong>{t('todayOverview')}</strong>
        <span>{t('todayCompleted', { done: summary.completed, total: summary.total })}</span>
      </div>
      <progress max={Math.max(1, summary.total)} value={summary.completed} aria-label={t('todayOverview')} />
      <div className="today-counts">
        {statuses.filter((status) => summary[status] > 0).map((status) => (
          <StatusBadge key={status} tone={todayStatusTone(status)}>
            {t(todayStatusKeys[status])} {summary[status]}
          </StatusBadge>
        ))}
      </div>
      <small>{t('todayScope')}</small>
    </section>
  );
}

export function SectionHeading({
  id,
  title,
  description,
  action,
}: {
  id?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2 id={id}>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function HistoryTable({
  records,
  sites,
}: {
  records: CheckinRecord[];
  sites: SiteView[];
}) {
  const { locale, t } = useI18n();
  const siteByOrigin = new Map(sites.map((site) => [site.origin, site]));
  return (
    <div className="history-table-wrap">
      <table className="history-table">
        <thead>
          <tr>
            <th>{t('recordTime')}</th>
            <th>{t('site')}</th>
            <th>{t('recordOutcome')}</th>
            <th>{t('reward')}</th>
            <th>{t('duration')}</th>
            <th>{t('retryCount')}</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const site = siteByOrigin.get(record.origin);
            const previous = site
              ? record.bindingGeneration !== site.binding.generation
              : true;
            return (
              <tr key={record.id}>
                <td>{formatDateTime(locale, record.attemptedAt)}</td>
                <td>
                  <span className="table-site">{site ? getSiteDisplayName(site) : record.origin}</span>
                  {previous ? <small>{t('previousBinding')}</small> : null}
                </td>
                <td><StatusBadge tone={recordTone(record)}>{t(recordOutcomeTranslationKey(record))}</StatusBadge></td>
                <td>{record.reward ?? ''}</td>
                <td>{formatDuration(locale, record.durationMs)}</td>
                <td>{record.retryCount}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
