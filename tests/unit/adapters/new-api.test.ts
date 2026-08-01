import { describe, expect, it, vi } from 'vitest';
import {
  fetchPublicStatus,
  getCheckinStatus,
  postCheckin,
  runNewApiCheckin,
} from '../../../src/adapters/new-api';
import type { FetchLike } from '../../../src/adapters/types';

const ORIGIN = 'https://panel.example';

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('New API legacy-session adapter', () => {
  it('uses the browser session and New-Api-User without Authorization', async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({
        success: true,
        data: { stats: { checked_in_today: false } },
      }),
    );
    const result = await getCheckinStatus({
      origin: ORIGIN,
      userId: 42,
      month: '2026-07',
      fetch: fetcher,
    });

    expect(result).toEqual({ ok: true, value: { checkedInToday: false } });
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe(`${ORIGIN}/api/user/checkin?month=2026-07`);
    expect(init?.credentials).toBe('include');
    const headers = new Headers(init?.headers);
    expect(headers.get('New-Api-User')).toBe('42');
    expect(headers.has('Authorization')).toBe(false);
  });

  it('parses public capabilities but treats missing pow mode as unknown', async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          checkin_enabled: true,
          turnstile_check: true,
          pow_enabled: true,
        },
      }),
    );
    await expect(
      fetchPublicStatus({ origin: ORIGIN, userId: 1, fetch: fetcher }),
    ).resolves.toEqual({
      ok: true,
      value: {
        checkinEnabled: true,
        turnstileCheck: true,
        powEnabled: true,
        powMode: 'unknown',
      },
    });
  });

  it('rechecks status and returns already checked without posting', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { checkin_enabled: true } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { stats: { checked_in_today: true } },
        }),
      );
    await expect(
      runNewApiCheckin({ origin: ORIGIN, userId: 9, fetch: fetcher }),
    ).resolves.toEqual({ code: 'already_checked', retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('requires user interaction before submitting a Turnstile site', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { checkin_enabled: true, turnstile_check: true },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { stats: { checked_in_today: false } },
        }),
      );
    await expect(
      runNewApiCheckin({ origin: ORIGIN, userId: 9, fetch: fetcher }),
    ).resolves.toMatchObject({
      code: 'action_required',
      actionReason: 'turnstile',
      retryable: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('submits an empty POST and only keeps an allowlisted reward field', async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({
        success: true,
        data: { reward: '  12 credits\n', token: 'must-not-leak' },
      }),
    );
    await expect(
      postCheckin({ origin: ORIGIN, userId: 8, fetch: fetcher }),
    ).resolves.toEqual({
      code: 'success',
      reward: '12 credits',
      retryable: false,
    });
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe(`${ORIGIN}/api/user/checkin`);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  });

  it('normalizes network failures as retryable and auth failures as action required', async () => {
    const networkFetch = vi.fn<FetchLike>().mockRejectedValue(new TypeError('offline'));
    await expect(
      getCheckinStatus({ origin: ORIGIN, userId: 1, fetch: networkFetch }),
    ).resolves.toMatchObject({
      ok: false,
      outcome: { errorCode: 'network', retryable: true },
    });

    const authFetch = vi.fn<FetchLike>().mockResolvedValue(new Response('', { status: 401 }));
    await expect(
      getCheckinStatus({ origin: ORIGIN, userId: 1, fetch: authFetch }),
    ).resolves.toMatchObject({
      ok: false,
      outcome: {
        code: 'action_required',
        actionReason: 'sign_in',
        errorCode: 'auth_failed',
      },
    });

    const loginHtml = vi.fn<FetchLike>().mockResolvedValue(
      new Response('<html>private login form</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    );
    await expect(
      getCheckinStatus({ origin: ORIGIN, userId: 1, fetch: loginHtml }),
    ).resolves.toMatchObject({
      ok: false,
      outcome: {
        code: 'action_required',
        actionReason: 'sign_in',
        errorCode: 'auth_failed',
      },
    });
  });
});
