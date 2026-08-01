import { describe, expect, it, vi } from 'vitest';
import {
  createPersistentBatch,
  discardIneligibleBatchOrigins,
  finishBatchOrigin,
  nextEligibleBatchOrigin,
} from '../../../src/background/batch';
import { createDefaultState } from '../../../src/shared/constants';
import type { SiteConfig } from '../../../src/shared/domain';

function site(origin: string, generation: string, enabled = true): SiteConfig {
  return {
    origin,
    label: new URL(origin).hostname,
    platform: 'new-api',
    adapterId: 'new-api-session',
    supportLevel: 'detected',
    enabled,
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    capabilities: { checkin: true, statusEndpoint: true },
    binding: {
      userId: 1,
      identitySource: 'uid',
      generation,
      boundAt: '2026-07-31T00:00:00.000Z',
      state: 'active',
    },
  };
}

describe('persistent batches', () => {
  it('captures enabled origins and their binding generations', () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000001',
    );
    const batch = createPersistentBatch(
      [site('https://a.example', 'a'), site('https://b.example', 'b', false)],
      'scheduled',
      '2026-07-31',
      new Date('2026-07-31T00:00:00.000Z'),
    );
    expect(batch.pendingOrigins).toEqual(['https://a.example']);
    expect(batch.bindingGenerations).toEqual({ 'https://a.example': 'a' });
  });

  it('skips paused and rebound sites before the next alarm', () => {
    const state = createDefaultState();
    state.sites['https://a.example'] = site('https://a.example', 'new');
    state.sites['https://b.example'] = site('https://b.example', 'b', false);
    const batch = {
      id: 'batch',
      scheduleDay: '2026-07-31',
      trigger: 'scheduled' as const,
      pendingOrigins: ['https://a.example', 'https://b.example'],
      bindingGenerations: {
        'https://a.example': 'old',
        'https://b.example': 'b',
      },
      createdAt: '2026-07-31T00:00:00.000Z',
    };
    expect(nextEligibleBatchOrigin(batch, state)).toBeUndefined();
    expect(discardIneligibleBatchOrigins(batch, state)).toBeUndefined();
  });

  it('persists a randomized next-site timestamp until the queue is empty', () => {
    const batch = {
      id: 'batch',
      scheduleDay: '2026-07-31',
      trigger: 'catchup' as const,
      pendingOrigins: ['https://a.example', 'https://b.example'],
      bindingGenerations: {
        'https://a.example': 'a',
        'https://b.example': 'b',
      },
      createdAt: '2026-07-31T00:00:00.000Z',
    };
    const next = finishBatchOrigin(
      batch,
      'https://a.example',
      new Date('2026-07-31T00:00:10.000Z'),
    );
    expect(next?.pendingOrigins).toEqual(['https://b.example']);
    expect(next?.nextOriginAt).toBe('2026-07-31T00:00:10.000Z');
    expect(finishBatchOrigin(next!, 'https://b.example')).toBeUndefined();
  });
});
