import { describe, expect, it } from 'vitest';
import {
  createRetryJob,
  dropInvalidRetries,
  isRetryJobDue,
  isRetryableOutcome,
  shouldAttemptRetryAfterStatus,
} from '../../../src/core';
import type { NormalizedOutcome, RetryJob } from '../../../src/shared/domain';
import { stateWithSite } from './fixtures';

const networkFailure: NormalizedOutcome = {
  code: 'failed',
  errorCode: 'network',
  retryable: true,
};

describe('retry policy', () => {
  it('only admits network, rate limit and server failures', () => {
    expect(isRetryableOutcome(networkFailure)).toBe(true);
    expect(
      isRetryableOutcome({ code: 'failed', errorCode: 'auth_failed', retryable: true }),
    ).toBe(false);
    expect(
      isRetryableOutcome({ code: 'failed', errorCode: 'server_error', retryable: false }),
    ).toBe(false);
  });

  it('plans 5 and 30 minute retries and honors a longer Retry-After', () => {
    const now = new Date(2026, 6, 31, 12, 0);
    const first = createRetryJob({
      origin: 'https://example.test',
      bindingGeneration: 'generation-a',
      scheduleDay: '2026-07-31',
      completedRetries: 0,
      originalTrigger: 'scheduled',
      outcome: networkFailure,
      now,
    });
    const second = createRetryJob({
      origin: 'https://example.test',
      bindingGeneration: 'generation-a',
      scheduleDay: '2026-07-31',
      completedRetries: 1,
      originalTrigger: 'manual',
      outcome: { ...networkFailure, retryAfterMs: 45 * 60_000 },
      now,
    });
    expect(Date.parse(first!.dueAt) - now.getTime()).toBe(5 * 60_000);
    expect(Date.parse(second!.dueAt) - now.getTime()).toBe(45 * 60_000);
    expect(second!.retryCount).toBe(2);
  });

  it('does not create a retry that would cross the local schedule day', () => {
    expect(
      createRetryJob({
        origin: 'https://example.test',
        bindingGeneration: 'generation-a',
        scheduleDay: '2026-07-31',
        completedRetries: 0,
        originalTrigger: 'scheduled',
        outcome: networkFailure,
        now: new Date(2026, 6, 31, 23, 58),
      }),
    ).toBeUndefined();
  });

  it('requires status preflight to report unchecked before retrying', () => {
    expect(shouldAttemptRetryAfterStatus({ checkedInToday: false })).toBe(true);
    expect(shouldAttemptRetryAfterStatus({ checkedInToday: true })).toBe(false);
    expect(shouldAttemptRetryAfterStatus({ code: 'already_checked', retryable: false })).toBe(false);
    expect(
      shouldAttemptRetryAfterStatus({ code: 'action_required', actionReason: 'sign_in', retryable: false }),
    ).toBe(false);
    expect(shouldAttemptRetryAfterStatus(networkFailure)).toBe(false);
  });

  it('drops stale-day, stale-binding and duplicate jobs', () => {
    const base: RetryJob = {
      id: 'kept',
      origin: 'https://example.test',
      bindingGeneration: 'generation-a',
      scheduleDay: '2026-07-31',
      retryCount: 1,
      dueAt: '2026-07-31T05:00:00.000Z',
      originalTrigger: 'scheduled',
    };
    const state = stateWithSite({
      retries: [
        base,
        { ...base, id: 'same-logical-job' },
        { ...base, id: 'old-day', scheduleDay: '2026-07-30' },
        { ...base, id: 'old-binding', bindingGeneration: 'generation-old' },
      ],
    });
    expect(dropInvalidRetries(state, '2026-07-31')).toEqual([base]);
    expect(isRetryJobDue(base, new Date('2026-07-31T05:01:00.000Z'))).toBe(true);
  });
});
