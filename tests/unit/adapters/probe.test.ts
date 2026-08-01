import { describe, expect, it, vi } from 'vitest';
import { probeAdapter } from '../../../src/adapters';
import type { FetchLike } from '../../../src/adapters/types';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('adapter probing', () => {
  it('marks a compatible generic New API site as detected', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { checkin_enabled: true } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { stats: { checked_in_today: false } },
        }),
      );
    await expect(
      probeAdapter({
        origin: 'https://panel.example',
        userId: 4,
        identitySource: 'uid',
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({
      supported: true,
      adapterId: 'new-api-session',
      platform: 'new-api',
      supportLevel: 'detected',
      checkedInToday: false,
    });
  });

  it('reports a session failure without returning server text', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { checkin_enabled: true } }),
      )
      .mockResolvedValueOnce(new Response('private page', { status: 401 }));
    await expect(
      probeAdapter({
        origin: 'https://panel.example',
        userId: 4,
        identitySource: 'uid',
        fetch: fetcher,
      }),
    ).resolves.toEqual({
      origin: 'https://panel.example',
      userId: 4,
      identitySource: 'uid',
      supported: false,
      reason: 'sign_in',
    });
  });
});

