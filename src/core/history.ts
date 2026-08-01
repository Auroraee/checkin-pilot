import {
  HISTORY_LIMIT_PER_SITE,
  HISTORY_RETENTION_DAYS,
} from '../shared/constants';
import type { CheckinRecord } from '../shared/domain';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns newest-first records, bounded globally by age and per origin by count. */
export function pruneHistory(
  records: readonly CheckinRecord[],
  now: Date = new Date(),
): CheckinRecord[] {
  const cutoff = now.getTime() - HISTORY_RETENTION_DAYS * DAY_MS;
  const counts = new Map<string, number>();

  return [...records]
    .filter((record) => {
      const attemptedAt = new Date(record.attemptedAt).getTime();
      return Number.isFinite(attemptedAt) && attemptedAt >= cutoff && attemptedAt <= now.getTime();
    })
    .sort((left, right) => Date.parse(right.attemptedAt) - Date.parse(left.attemptedAt))
    .filter((record) => {
      const count = counts.get(record.origin) ?? 0;
      if (count >= HISTORY_LIMIT_PER_SITE) return false;
      counts.set(record.origin, count + 1);
      return true;
    });
}
