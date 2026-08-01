import type { ReactNode } from 'react';
import {
  AirplaneTilt,
  ArrowSquareOut,
  BellRinging,
  CheckCircle,
  Clock,
  GearSix,
  PauseCircle,
  Play,
  Trash,
  WarningCircle,
  XCircle,
} from '@phosphor-icons/react';
import type { CheckinRecord, SiteView } from '../shared/domain';
import { useI18n } from './i18n';
import {
  formatDateTime,
  formatDuration,
  getSiteDisplayName,
  outcomeTranslationKey,
  recordTone,
} from './format';

export type Tone = 'success' | 'warning' | 'danger' | 'neutral' | 'accent';

export function AppHeader({ trailing }: { trailing?: ReactNode }) {
  const { t } = useI18n();
  return (
    <header className="app-header">
      <div className="brand-mark" aria-hidden="true">
        <AirplaneTilt weight="fill" size={20} />
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
    return { key: 'statusActionRequired' as const, tone: 'warning' as Tone };
  }
  if (!site.enabled) return { key: 'disabled' as const, tone: 'neutral' as Tone };
  if (!site.latestRecord) return { key: 'statusReady' as const, tone: 'neutral' as Tone };
  return {
    key: outcomeTranslationKey(site.latestRecord.outcome),
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
}: {
  site: SiteView;
  running?: boolean;
  busy?: boolean;
  onToggle: (enabled: boolean) => void;
  onManual: () => void;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  const { locale, t } = useI18n();
  const displayName = getSiteDisplayName(site);
  const status = siteStatus(site, running);

  return (
    <article className="site-card">
      <div className="site-card-main">
        <div className="site-identity">
          <div className="site-heading">
            <strong title={site.origin}>{displayName}</strong>
            <StatusBadge tone={status.tone}>{t(status.key)}</StatusBadge>
          </div>
          <span className="site-origin">{site.origin}</span>
          <span className="site-meta">
            {site.latestRecord
              ? `${t('lastResult')}: ${formatDateTime(locale, site.latestRecord.attemptedAt)}`
              : t('never')}
          </span>
        </div>
        <Switch
          checked={site.enabled}
          onChange={onToggle}
          label={t('toggleSite', { site: displayName })}
          disabled={busy}
        />
      </div>
      <div className="site-actions">
        <Button
          variant="secondary"
          icon={<Play size={16} weight="fill" />}
          onClick={onManual}
          disabled={busy || running}
        >
          {running ? t('checking') : t('manualCheck')}
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
}: {
  nextBatchAt: string | undefined;
  state: 'scheduled' | 'running' | 'complete' | undefined;
}) {
  const { locale, t } = useI18n();
  const statusKey = state === 'running'
    ? 'scheduleRunning'
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

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function SettingsIcon() {
  return <GearSix size={19} />;
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
                <td><StatusBadge tone={recordTone(record)}>{t(outcomeTranslationKey(record.outcome))}</StatusBadge></td>
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
