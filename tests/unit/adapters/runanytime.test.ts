import { describe, expect, it, vi } from 'vitest';
import {
  decideRunanytimeSecurity,
  fetchRunanytimeChallenge,
  RUNANYTIME_ORIGIN,
  runRunanytimeCheckin,
} from '../../../src/adapters/runanytime';
import type {
  FetchLike,
  PublicSiteStatus,
} from '../../../src/adapters/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function status(overrides: Partial<PublicSiteStatus>): PublicSiteStatus {
  return {
    checkinEnabled: true,
    turnstileCheck: false,
    powEnabled: true,
    powMode: 'replace',
    ...overrides,
  };
}

describe('runanytime private PoW adapter', () => {
  it.each([
    [status({ powMode: 'replace', turnstileCheck: true }), 'pow'],
    [status({ powMode: 'supplement', turnstileCheck: false }), 'turnstile'],
    [status({ powMode: 'fallback', turnstileCheck: true }), 'turnstile'],
    [status({ powMode: 'fallback', turnstileCheck: false }), 'pow'],
    [status({ powMode: 'unknown' }), 'unknown'],
    [status({ powEnabled: false, turnstileCheck: false }), 'direct'],
    [status({ powEnabled: false, turnstileCheck: true }), 'turnstile'],
  ] as const)('applies strict security-mode precedence', (input, expected) => {
    expect(decideRunanytimeSecurity(input)).toBe(expected);
  });

  it('gets the challenge with session auth headers and validates its bounds', async () => {
    const acquired = vi.fn();
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({
        success: true,
        data: { challenge_id: 'challenge-1', prefix: 'prefix:', difficulty: 18 },
      }),
    );
    await expect(
      fetchRunanytimeChallenge({
        origin: RUNANYTIME_ORIGIN,
        userId: 21,
        fetch: fetcher,
        onPowChallengeAcquired: acquired,
      }),
    ).resolves.toEqual({
      ok: true,
      value: { challengeId: 'challenge-1', prefix: 'prefix:', difficulty: 18 },
    });
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe(
      `${RUNANYTIME_ORIGIN}/api/user/pow/challenge?action=checkin`,
    );
    expect(init?.credentials).toBe('include');
    const headers = new Headers(init?.headers);
    expect(headers.get('New-Api-User')).toBe('21');
    expect(headers.has('Authorization')).toBe(false);
    expect(acquired).toHaveBeenCalledOnce();
  });

  it('counts an acquired challenge before rejecting difficulty outside 10 through 20', async () => {
    const acquired = vi.fn();
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({
        success: true,
        data: { challenge_id: 'challenge-1', prefix: 'prefix:', difficulty: 21 },
      }),
    );
    await expect(
      fetchRunanytimeChallenge({
        origin: RUNANYTIME_ORIGIN,
        userId: 21,
        fetch: fetcher,
        onPowChallengeAcquired: acquired,
      }),
    ).resolves.toMatchObject({
      ok: false,
      outcome: { errorCode: 'pow_difficulty_out_of_range', retryable: false },
    });
    expect(acquired).toHaveBeenCalledOnce();
  });

  it('does not acquire a challenge for supplement mode', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            checkin_enabled: true,
            pow_enabled: true,
            pow_mode: 'supplement',
            turnstile_check: true,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { stats: { checked_in_today: false } },
        }),
      );
    const solve = vi.fn();
    await expect(
      runRunanytimeCheckin({
        origin: RUNANYTIME_ORIGIN,
        userId: 5,
        fetch: fetcher,
        solvePow: solve,
      }),
    ).resolves.toMatchObject({
      code: 'action_required',
      actionReason: 'turnstile',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(solve).not.toHaveBeenCalled();
  });

  it('does not fetch a challenge after the shared daily budget is exhausted', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            checkin_enabled: true,
            pow_enabled: true,
            pow_mode: 'replace',
            turnstile_check: true,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { stats: { checked_in_today: false } },
        }),
      );
    await expect(
      runRunanytimeCheckin({
        origin: RUNANYTIME_ORIGIN,
        userId: 5,
        fetch: fetcher,
        solvePow: vi.fn(),
        powMaxMs: 0,
      }),
    ).resolves.toMatchObject({
      code: 'action_required',
      actionReason: 'unknown_challenge',
      errorCode: 'pow_budget_exhausted',
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('solves replace mode once and immediately submits the nonce', async () => {
    const calls: string[] = [];
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/api/status')) {
        return jsonResponse({
          success: true,
          data: {
            checkin_enabled: true,
            pow_enabled: true,
            pow_mode: 'replace',
            turnstile_check: true,
          },
        });
      }
      if (url.includes('/api/user/checkin?month=')) {
        return jsonResponse({
          success: true,
          data: { stats: { checked_in_today: false } },
        });
      }
      if (url.includes('/api/user/pow/challenge')) {
        return jsonResponse({
          success: true,
          data: { challenge_id: 'c id', prefix: 'private-prefix', difficulty: 18 },
        });
      }
      return jsonResponse({ success: true, data: { reward: 3 } });
    });
    const acquired = vi.fn();
    const workerUsed = vi.fn();
    const solvePow = vi.fn().mockResolvedValue({
      status: 'solved',
      nonce: '0000beef',
      elapsedMs: 125,
    });

    await expect(
      runRunanytimeCheckin({
        origin: RUNANYTIME_ORIGIN,
        userId: 5,
        fetch: fetcher,
        solvePow,
        powMaxMs: 500,
        onPowChallengeAcquired: acquired,
        onPowWorkerUsed: workerUsed,
      }),
    ).resolves.toEqual({ code: 'success', reward: '3', retryable: false });
    expect(solvePow).toHaveBeenCalledWith({
      prefix: 'private-prefix',
      difficulty: 18,
      maxMs: 500,
    });
    expect(acquired).toHaveBeenCalledOnce();
    expect(workerUsed).toHaveBeenCalledWith(125);
    expect(calls.at(-1)).toBe(
      `POST ${RUNANYTIME_ORIGIN}/api/user/checkin?pow_challenge=c+id&pow_nonce=0000beef`,
    );
  });

  it('rechecks status before one budget-approved replacement challenge', async () => {
    let checkinGets = 0;
    let challengeGets = 0;
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/status')) {
        return jsonResponse({
          success: true,
          data: {
            checkin_enabled: true,
            pow_enabled: true,
            pow_mode: 'replace',
            turnstile_check: true,
          },
        });
      }
      if (url.includes('/api/user/checkin?month=')) {
        checkinGets += 1;
        return jsonResponse({
          success: true,
          data: { stats: { checked_in_today: false } },
        });
      }
      if (url.includes('/api/user/pow/challenge')) {
        challengeGets += 1;
        return jsonResponse({
          success: true,
          data: {
            challenge_id: `challenge-${challengeGets}`,
            prefix: `prefix-${challengeGets}`,
            difficulty: 18,
          },
        });
      }
      expect(init?.method).toBe('POST');
      return jsonResponse({ success: true, data: {} });
    });
    const budget = vi
      .fn()
      .mockReturnValueOnce({ allowed: true, maxMs: 400 })
      .mockReturnValueOnce({ allowed: true, maxMs: 300 });
    const solver = vi
      .fn()
      .mockResolvedValueOnce({ status: 'timeout', elapsedMs: 400 })
      .mockResolvedValueOnce({
        status: 'solved',
        nonce: '0000000a',
        elapsedMs: 200,
      });
    const acquired = vi.fn();

    await expect(
      runRunanytimeCheckin({
        origin: RUNANYTIME_ORIGIN,
        userId: 5,
        fetch: fetcher,
        solvePow: solver,
        getPowAttemptBudget: budget,
        onPowChallengeAcquired: acquired,
      }),
    ).resolves.toMatchObject({ code: 'success' });
    expect(checkinGets).toBe(2);
    expect(challengeGets).toBe(2);
    expect(acquired).toHaveBeenCalledTimes(2);
    expect(solver.mock.calls[1]?.[0]).toMatchObject({
      prefix: 'prefix-2',
      maxMs: 300,
    });
  });

  it('stops after recheck when no budget remains for a replacement challenge', async () => {
    let challengeGets = 0;
    const fetcher: FetchLike = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/status')) {
        return jsonResponse({
          success: true,
          data: {
            checkin_enabled: true,
            pow_enabled: true,
            pow_mode: 'replace',
          },
        });
      }
      if (url.includes('/api/user/checkin?month=')) {
        return jsonResponse({
          success: true,
          data: { stats: { checked_in_today: false } },
        });
      }
      challengeGets += 1;
      return jsonResponse({
        success: true,
        data: { challenge_id: 'one', prefix: 'prefix', difficulty: 18 },
      });
    });
    const budget = vi
      .fn()
      .mockReturnValueOnce({ allowed: true, maxMs: 100 })
      .mockReturnValueOnce({ allowed: false, maxMs: 0 });

    await expect(
      runRunanytimeCheckin({
        origin: RUNANYTIME_ORIGIN,
        userId: 5,
        fetch: fetcher,
        solvePow: vi
          .fn()
          .mockResolvedValue({ status: 'timeout', elapsedMs: 100 }),
        getPowAttemptBudget: budget,
      }),
    ).resolves.toMatchObject({
      code: 'action_required',
      actionReason: 'unknown_challenge',
      errorCode: 'pow_budget_exhausted',
    });
    expect(challengeGets).toBe(1);
  });
});
