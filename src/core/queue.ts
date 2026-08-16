import {
  SERIAL_DELAY_MAX_MS,
  SERIAL_DELAY_MIN_MS,
} from '../shared/constants';
import type { CheckinRecord, SiteConfig, TriggerKind } from '../shared/domain';

export function isSiteEligibleForTrigger(site: SiteConfig, trigger: TriggerKind): boolean {
  if (trigger === 'manual') return true;
  if (trigger === 'retry') return true;
  return site.enabled;
}

/**
 * A same-origin-refresh site whose refresh/status returned 401 stops for the
 * rest of its schedule day (one notification). The next scheduled batch tries
 * it once again and auto-resumes after the user signs back in. Legacy sites
 * paused with `auth_upgrade_required` stay out until the user updates them.
 */
export function isStoppedForTheDay(
  site: SiteConfig,
  records: readonly CheckinRecord[],
  scheduleDay: string,
): boolean {
  if (site.binding.state !== 'action_required') return false;
  if (site.binding.actionReason === 'auth_upgrade_required') return true;
  if (site.binding.actionReason === 'sign_in' && site.authMode === 'same-origin-refresh') {
    return records.some(
      (record) =>
        record.origin === site.origin &&
        record.scheduleDay === scheduleDay &&
        record.outcome === 'action_required' &&
        record.actionReason === 'sign_in',
    );
  }
  return false;
}

export function selectSitesForTrigger(
  sites: Iterable<SiteConfig>,
  trigger: TriggerKind,
  manualOrigin?: string,
): SiteConfig[] {
  return [...sites]
    .filter((site) => {
      if (trigger === 'manual' && manualOrigin && site.origin !== manualOrigin) return false;
      return isSiteEligibleForTrigger(site, trigger);
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.origin.localeCompare(right.origin));
}

export function randomSerialDelayMs(random: () => number = Math.random): number {
  const sample = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);
  return Math.floor(
    SERIAL_DELAY_MIN_MS + sample * (SERIAL_DELAY_MAX_MS - SERIAL_DELAY_MIN_MS + 1),
  );
}

