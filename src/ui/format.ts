import type { ActionReason, CheckinRecord, OutcomeCode, SiteView } from '../shared/domain';
import type { TranslationKey, UiLocale } from '../locales/translations';

export function minutesToTimeInput(minutes: number): string {
  const safeMinutes = Math.max(0, Math.min(23 * 60 + 59, Math.floor(minutes)));
  const hours = Math.floor(safeMinutes / 60).toString().padStart(2, '0');
  const remainder = (safeMinutes % 60).toString().padStart(2, '0');
  return `${hours}:${remainder}`;
}

export function timeInputToMinutes(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

export function formatDateTime(locale: UiLocale, iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

export function formatTime(locale: UiLocale, iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

export function formatDuration(locale: UiLocale, durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))} ms`;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    durationMs / 1_000,
  ) + ' s';
}

export function getSiteDisplayName(site: Pick<SiteView, 'label' | 'origin'>): string {
  if (site.label.trim()) return site.label.trim();
  try {
    return new URL(site.origin).hostname;
  } catch {
    return site.origin;
  }
}

export function outcomeTranslationKey(outcome: OutcomeCode): TranslationKey {
  const keys: Record<OutcomeCode, TranslationKey> = {
    success: 'statusSuccess',
    already_checked: 'alreadyChecked',
    action_required: 'statusActionRequired',
    failed: 'statusFailed',
    unsupported: 'statusUnsupported',
    cancelled: 'statusCancelled',
    unverified: 'statusUnverified',
  };
  return keys[outcome];
}

const ACTION_REASON_KEYS: Record<ActionReason, TranslationKey> = {
  sign_in: 'actionSignIn',
  account_changed: 'actionRebind',
  rebind_required: 'actionRebind',
  auth_upgrade_required: 'actionUpgradeAuth',
  turnstile: 'actionChallenge',
  captcha: 'actionChallenge',
  unknown_challenge: 'actionChallenge',
  permission_missing: 'actionPermission',
  identity_missing: 'actionRebind',
};

export function actionReasonTranslationKey(
  reason: ActionReason | undefined,
): TranslationKey {
  return reason === undefined ? 'statusActionRequired' : ACTION_REASON_KEYS[reason];
}

/** Like outcomeTranslationKey, but action_required surfaces its specific reason. */
export function recordOutcomeTranslationKey(
  record: Pick<CheckinRecord, 'outcome' | 'actionReason'>,
): TranslationKey {
  if (record.outcome === 'action_required') {
    return actionReasonTranslationKey(record.actionReason);
  }
  return outcomeTranslationKey(record.outcome);
}

export function recordTone(record: CheckinRecord | undefined):
  | 'success'
  | 'warning'
  | 'danger'
  | 'neutral' {
  if (!record) return 'neutral';
  if (record.outcome === 'success' || record.outcome === 'already_checked') {
    return 'success';
  }
  if (record.outcome === 'action_required') return 'warning';
  if (record.outcome === 'failed') return 'danger';
  // cancelled and unverified are terminal, neutral results.
  return 'neutral';
}
