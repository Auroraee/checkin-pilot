import { describe, expect, it, vi } from 'vitest';
import {
  decideRunanytimeSecurity,
  RUNANYTIME_ORIGIN,
  runRunanytimeCheckin,
} from '../../../src/adapters/runanytime';
import { LegacySessionTransport } from '../../../src/auth/legacy-transport';
import type {
  FetchLike,
  PublicSiteStatus,
} from '../../../src/adapters/types';
import type { AuthTransport } from '../../../src/auth/types';

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

interface RunanytimeTestContext {
  origin: string;
  userId: number;
  adapterId: 'runanytime';
  authMode: 'legacy-session';
  month: string;
  fetch: FetchLike;
  transport: AuthTransport;
}

function legacyContext(
  userId: number,
  fetcher: FetchLike,
  options: Partial<ConstructorParameters<typeof LegacySessionTransport>[0]> = {},
): RunanytimeTestContext {
  return {
    origin: RUNANYTIME_ORIGIN,
    userId,
    adapterId: 'runanytime',
    authMode: 'legacy-session',
    month: '2026-07',
    fetch: fetcher,
    transport: new LegacySessionTransport({
      origin: RUNANYTIME_ORIGIN,
      userId,
      fetch: fetcher,
      ...options,
    }),
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
    // A fresh Response per call: a fetch body can only be read once.
    const fetcher = vi.fn<FetchLike>().mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          success: true,
          data: { challenge_id: 'challenge-1', prefix: 'prefix:', difficulty: 18 },
        }),
      ),
    );
    const context = legacyContext(21, fetcher, {
      powMaxMs: 500,
      solvePow: vi.fn().mockResolvedValue({
        status: 'solved',
        nonce: '0000000f',
        elapsedMs: 5,
      }),
      onPowChallengeAcquired: acquired,
    });
    // Replace the shared fetcher: status + status-check + challenge + submit.
    fetcher
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
        jsonResponse({ success: true, data: { stats: { checked_in_today: false } } }),
      );
    await expect(runRunanytimeCheckin(context)).resolves.toMatchObject({
      code: 'success',
    });
    const challengeCall = fetcher.mock.calls.find(
      ([input]) => String(input).includes('/api/user/pow/challenge'),
    );
    const [challengeInput, challengeInit] = challengeCall ?? [];
    expect(String(challengeInput)).toBe(
      `${RUNANYTIME_ORIGIN}/api/user/pow/challenge?action=checkin`,
    );
    expect(challengeInit?.credentials).toBe('include');
    const headers = new Headers(challengeInit?.headers);
    expect(headers.get('New-Api-User')).toBe('21');
    expect(headers.has('Authorization')).toBe(false);
    expect(acquired).toHaveBeenCalledOnce();
  });

  it('counts an acquired challenge before rejecting difficulty outside 10 through 20', async () => {
    const acquired = vi.fn();
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
        jsonResponse({ success: true, data: { stats: { checked_in_today: false } } }),
      )
      .mockResolvedValue(
        jsonResponse({
          success: true,
          data: { challenge_id: 'challenge-1', prefix: 'prefix:', difficulty: 21 },
        }),
      );
    await expect(
      runRunanytimeCheckin(
        legacyContext(21, fetcher, {
          powMaxMs: 500,
          solvePow: vi.fn(),
          onPowChallengeAcquired: acquired,
        }),
      ),
    ).resolves.toMatchObject({
      code: 'failed',
      errorCode: 'pow_difficulty_out_of_range',
      retryable: false,
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
      runRunanytimeCheckin(
        legacyContext(5, fetcher, { powMaxMs: 500, solvePow: solve }),
      ),
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
      runRunanytimeCheckin(
        legacyContext(5, fetcher, { powMaxMs: 0, solvePow: vi.fn() }),
      ),
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
      runRunanytimeCheckin(
        legacyContext(5, fetcher, {
          powMaxMs: 500,
          solvePow,
          onPowChallengeAcquired: acquired,
          onPowWorkerUsed: workerUsed,
        }),
      ),
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
      runRunanytimeCheckin(
        legacyContext(5, fetcher, {
          solvePow: solver,
          getPowAttemptBudget: budget,
          onPowChallengeAcquired: acquired,
        }),
      ),
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
      runRunanytimeCheckin(
        legacyContext(5, fetcher, {
          solvePow: vi
            .fn()
            .mockResolvedValue({ status: 'timeout', elapsedMs: 100 }),
          getPowAttemptBudget: budget,
        }),
      ),
    ).resolves.toMatchObject({
      code: 'action_required',
      actionReason: 'unknown_challenge',
      errorCode: 'pow_budget_exhausted',
    });
    expect(challengeGets).toBe(1);
  });
});
