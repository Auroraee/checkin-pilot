import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { HUAIBAO_ORIGIN } from '../../../src/adapters/huaibao-signature';
import { getCheckinStatus, postCheckin, runNewApiCheckin } from '../../../src/adapters/new-api';
import { LegacySessionTransport } from '../../../src/auth/legacy-transport';
import type { FetchLike } from '../../../src/adapters/types';

const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { headers: { 'Content-Type': 'application/json' } });

describe('Huainova check-in signature', () => {
  it('reads the server nonce and signs the same account, Unix seconds and nonce as the website', async () => {
    const nonce = 'request-only-nonce';
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(json({ checkin_enabled: true }))
      .mockResolvedValueOnce(json({ stats: { checked_in_today: false }, checkin_nonce: nonce }))
      .mockResolvedValueOnce(json({ quota_awarded: 5 }));
    const outcome = await runNewApiCheckin({ origin: HUAIBAO_ORIGIN, userId: 42, month: '2026-09',
      adapterId: 'new-api', authMode: 'legacy-session', fetch: fetcher,
      transport: new LegacySessionTransport({ origin: HUAIBAO_ORIGIN, userId: 42, fetch: fetcher }),
    });
    expect(outcome).toEqual({ code: 'success', reward: '5', retryable: false });
    const [url, init] = fetcher.mock.calls[2]!;
    expect(String(url)).toBe(`${HUAIBAO_ORIGIN}/api/user/checkin`);
    const headers = new Headers(init?.headers);
    const timestamp = headers.get('X-Checkin-Timestamp');
    expect(timestamp).toMatch(/^\d+$/);
    expect(Math.abs(Number(timestamp) - Math.floor(Date.now() / 1000))).toBeLessThan(2);
    expect(headers.get('X-Checkin-Signature')).toBe(createHash('sha256').update(`42:${timestamp}:${nonce}`).digest('hex'));
    expect(headers.get('New-Api-User')).toBe('42');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init?.body).toBe('{}');
    expect(JSON.stringify(outcome)).not.toContain(nonce);
  });

  it.each([undefined, '', 'x'.repeat(4097)])('refuses to submit with a missing or malformed nonce', async (nonce) => {
    const fetcher = vi.fn<FetchLike>();
    expect(await postCheckin({ origin: HUAIBAO_ORIGIN, userId: 42, fetch: fetcher },
      nonce === undefined ? {} : { checkinNonce: nonce })).toMatchObject({ errorCode: 'invalid_response', retryable: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not copy a nonce or attach custom headers for other origins', async () => {
    const fetcher = vi.fn<FetchLike>()
      .mockResolvedValueOnce(json({ stats: { checked_in_today: false }, checkin_nonce: 'nonce' }))
      .mockResolvedValueOnce(json({ reward: 1 }));
    const context = { origin: 'https://other.example', userId: 42, fetch: fetcher };
    expect(await getCheckinStatus(context)).toEqual({ ok: true, value: { checkedInToday: false } });
    await postCheckin(context, { checkinNonce: 'nonce' });
    const init = fetcher.mock.calls[1]?.[1];
    expect(new Headers(init?.headers).has('X-Checkin-Signature')).toBe(false);
    expect(init?.body).toBeUndefined();
  });
});
