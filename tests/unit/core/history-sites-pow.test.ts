import { describe, expect, it } from 'vitest';
import {
  buildSiteViews,
  clearExpiredPowLedgers,
  hasSuccessfulCheckinToday,
  powLedgerKey,
  pruneHistory,
  readPowBudget,
  recordPowUsage,
  removeSite,
  reservePowChallenge,
} from '../../../src/core';
import type { CheckinRecord } from '../../../src/shared/domain';
import { record, site, stateWithSite } from './fixtures';

describe('history and binding generations', () => {
  it('keeps no more than 30 days and 100 records per site', () => {
    const now = new Date('2026-07-31T12:00:00.000Z');
    const records: CheckinRecord[] = Array.from({ length: 105 }, (_, index) =>
      record({
        id: `record-${index}`,
        attemptedAt: new Date(now.getTime() - index * 60_000).toISOString(),
      }),
    );
    records.push(record({ id: 'expired', attemptedAt: '2026-06-01T00:00:00.000Z' }));
    const pruned = pruneHistory(records, now);
    expect(pruned).toHaveLength(100);
    expect(pruned.some((item) => item.id === 'expired')).toBe(false);
    expect(pruned[0]?.id).toBe('record-0');
  });

  it('excludes old-binding records from the current summary after a rebind', () => {
    const original = site();
    const rebound = {
      ...original,
      binding: {
        ...original.binding,
        userId: 8,
        identitySource: 'user.id' as const,
        generation: 'generation-b',
      },
    };
    const state = stateWithSite({
      sites: { [rebound.origin]: rebound },
      records: [
        record({ id: 'old', bindingGeneration: 'generation-a' }),
        record({ id: 'current', bindingGeneration: 'generation-b' }),
      ],
    });
    const [view] = buildSiteViews(state);
    expect(view?.binding.userId).toBe(8);
    expect(view?.latestRecord?.id).toBe('current');
    expect(view?.isPreviousBindingRecordExcluded).toBe(true);
  });

  it('reports today as done only for a same-day success on the current binding', () => {
    const current = site();
    const records = [
      record({ id: 'manual', trigger: 'manual' }),
      record({ id: 'failed', outcome: 'failed', attemptedAt: '2026-07-31T02:00:00.000Z' }),
    ];
    expect(hasSuccessfulCheckinToday(current, records, '2026-07-31')).toBe(true);
    expect(
      hasSuccessfulCheckinToday(current, [record({ outcome: 'already_checked' })], '2026-07-31'),
    ).toBe(true);
    expect(hasSuccessfulCheckinToday(current, [record({ outcome: 'failed' })], '2026-07-31')).toBe(
      false,
    );
    expect(hasSuccessfulCheckinToday(current, [record()], '2026-08-01')).toBe(false);
    expect(
      hasSuccessfulCheckinToday(
        current,
        [record({ bindingGeneration: 'generation-old' })],
        '2026-07-31',
      ),
    ).toBe(false);
  });
});

describe('shared per-origin PoW ledger', () => {
  it('reserves only two acquired challenges across all triggers', () => {
    const base = stateWithSite();
    const once = reservePowChallenge(base, 'https://example.test', '2026-07-31')!;
    const twice = reservePowChallenge(once, 'https://example.test', '2026-07-31')!;
    expect(readPowBudget(twice, 'https://example.test', '2026-07-31').canStart).toBe(false);
    expect(reservePowChallenge(twice, 'https://example.test', '2026-07-31')).toBeUndefined();
  });

  it('caps each usage at 12 seconds and the daily total at 24 seconds', () => {
    const base = stateWithSite();
    const first = recordPowUsage(base, 'https://example.test', '2026-07-31', 30_000);
    const second = recordPowUsage(first, 'https://example.test', '2026-07-31', 30_000);
    const budget = readPowBudget(second, 'https://example.test', '2026-07-31');
    expect(budget.ledger.workerMsUsed).toBe(24_000);
    expect(budget.canStart).toBe(false);
  });

  it('removal deletes site data but preserves a same-day budget tombstone', () => {
    const origin = 'https://example.test';
    let state = stateWithSite({
      records: [record()],
      activeBatch: {
        id: 'batch',
        scheduleDay: '2026-07-31',
        trigger: 'scheduled',
        pendingOrigins: [origin],
        bindingGenerations: { [origin]: 'generation-a' },
        createdAt: '2026-07-31T00:00:00.000Z',
      },
      retries: [
        {
          id: 'retry',
          origin,
          bindingGeneration: 'generation-a',
          scheduleDay: '2026-07-31',
          retryCount: 1,
          dueAt: '2026-07-31T10:00:00.000Z',
          originalTrigger: 'manual',
        },
      ],
    });
    state = reservePowChallenge(state, origin, '2026-07-31')!;
    const removed = removeSite(state, origin, '2026-07-31');
    expect(removed.sites[origin]).toBeUndefined();
    expect(removed.records).toEqual([]);
    expect(removed.retries).toEqual([]);
    expect(removed.activeBatch).toBeUndefined();
    expect(removed.powLedgers[powLedgerKey(origin, '2026-07-31')]).toMatchObject({
      challengesUsed: 1,
      removedSiteTombstone: true,
    });
  });

  it('expires all ledgers and tombstones after local midnight', () => {
    const origin = 'https://example.test';
    const removed = removeSite(stateWithSite(), origin, '2026-07-31');
    const cleared = clearExpiredPowLedgers(removed, '2026-08-01');
    expect(cleared.powLedgers).toEqual({});
  });
});
