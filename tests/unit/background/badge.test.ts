import { describe, expect, it, vi } from 'vitest';
vi.mock('wxt/browser', () => ({ browser: {} }));
import { badgeForToday } from '../../../src/background/badge';
import type { TodaySummary } from '../../../src/shared/domain';

const summary: TodaySummary = { total: 2, completed: 1, failed: 1, attention: 0, pending: 0,
  paused: 0, running: 0, retrying: 0, unverified: 0 };

describe('aggregate badge', () => {
  it('keeps a failed site visible after another site succeeds', () => {
    expect(badgeForToday(summary).text).toBe('1');
    expect(badgeForToday({ ...summary, failed: 0, completed: 2 }).text).toBe('✓');
  });
  it('never treats pending work, retries, unverified visits or an empty day as all done', () => {
    expect(badgeForToday({ ...summary, failed: 0, pending: 1 }).text).toBe('');
    expect(badgeForToday({ ...summary, failed: 0, retrying: 1 }).text).toBe('…');
    expect(badgeForToday({ ...summary, failed: 0, unverified: 1 }).text).toBe('?');
    expect(badgeForToday({ ...summary, failed: 0, completed: 0, total: 0 }).text).toBe('');
  });
});
