import { describe, expect, it, vi } from 'vitest';
import { probeSite } from '../../../src/auth/probe';
import { probeLegacySite } from '../../../src/adapters';
import type { FetchLike } from '../../../src/adapters/types';
import type { ModernProbeResult } from '../../../src/auth/types';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('site probing (modern-first)', () => {
  it('prefers the modern refresh probe and reports its account identity', async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({ success: true, data: { checkin_enabled: true } }),
    );
    const modernProbe = vi.fn(async (): Promise<ModernProbeResult> => ({
      kind: 'modern',
      userId: 42,
      checkedInToday: false,
    }));
    await expect(
      probeSite(
        { origin: 'https://panel.example', userId: 7, identitySource: 'uid', month: '2026-08', fetch: fetcher },
        modernProbe,
      ),
    ).resolves.toMatchObject({
      supported: true,
      userId: 42,
      identitySource: 'refresh',
      adapterId: 'new-api',
      authMode: 'same-origin-refresh',
      checkedInToday: false,
    });
    expect(modernProbe).toHaveBeenCalledWith('https://panel.example', undefined, '2026-08');
  });

  it('never collapses a refresh 401 into "incompatible"', async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({ success: true, data: { checkin_enabled: true } }),
    );
    const modernProbe = vi.fn(async (): Promise<ModernProbeResult> => ({ kind: 'needs_login' }));
    await expect(
      probeSite({ origin: 'https://panel.example', userId: 7, identitySource: 'uid', month: '2026-08', fetch: fetcher }, modernProbe),
    ).resolves.toEqual({
      origin: 'https://panel.example',
      userId: 7,
      identitySource: 'uid',
      supported: false,
      reason: 'sign_in',
    });
  });

  it('falls back to legacy session probing only when refresh is absent (404/405)', async () => {
    const fetcher = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { checkin_enabled: true } }),
      )
      // probeSite and probeLegacySite each fetch the public status.
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { checkin_enabled: true } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { stats: { checked_in_today: true } },
        }),
      );
    const modernProbe = vi.fn(async (): Promise<ModernProbeResult> => ({ kind: 'legacy_only' }));
    await expect(
      probeSite(
        { origin: 'https://panel.example', userId: 7, identitySource: 'uid', month: '2026-08', fetch: fetcher },
        modernProbe,
      ),
    ).resolves.toMatchObject({
      supported: true,
      userId: 7,
      identitySource: 'uid',
      adapterId: 'new-api',
      authMode: 'legacy-session',
      checkedInToday: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('requires a page identity before the legacy fallback', async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({ success: true, data: { checkin_enabled: true } }),
    );
    const modernProbe = vi.fn(async (): Promise<ModernProbeResult> => ({ kind: 'legacy_only' }));
    await expect(
      probeSite({ origin: 'https://panel.example', month: '2026-08', fetch: fetcher }, modernProbe),
    ).resolves.toEqual({
      origin: 'https://panel.example',
      userId: 0,
      identitySource: 'uid',
      supported: false,
      reason: 'identity_missing',
    });
  });

  it('marks unknown private challenges as unsupported instead of guessing', async () => {
    const fetcher = vi.fn<FetchLike>().mockResolvedValue(
      jsonResponse({
        success: true,
        data: { checkin_enabled: true, pow_enabled: true, pow_mode: 'unknown' },
      }),
    );
    const modernProbe = vi.fn();
    await expect(
      probeSite({ origin: 'https://panel.example', userId: 7, identitySource: 'uid', month: '2026-08', fetch: fetcher }, modernProbe),
    ).resolves.toMatchObject({ supported: false, reason: 'unknown_challenge' });
    expect(modernProbe).not.toHaveBeenCalled();
  });
});

describe('legacy session probing', () => {
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
      probeLegacySite({
        origin: 'https://panel.example',
        userId: 4,
        identitySource: 'uid',
        fetch: fetcher,
      }),
    ).resolves.toMatchObject({
      supported: true,
      adapterId: 'new-api',
      platform: 'new-api',
      authMode: 'legacy-session',
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
      probeLegacySite({
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
