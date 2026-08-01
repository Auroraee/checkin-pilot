import { createDefaultState } from '../../../src/shared/constants';
import type { CheckinRecord, SiteConfig, StorageState } from '../../../src/shared/domain';

export function site(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    origin: 'https://example.test',
    label: 'Example',
    platform: 'new-api',
    adapterId: 'new-api-session',
    supportLevel: 'detected',
    enabled: true,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    capabilities: { checkin: true, statusEndpoint: true },
    binding: {
      userId: 7,
      identitySource: 'uid',
      generation: 'generation-a',
      boundAt: '2026-07-01T00:00:00.000Z',
      state: 'active',
    },
    ...overrides,
  };
}

export function record(overrides: Partial<CheckinRecord> = {}): CheckinRecord {
  return {
    id: 'record-1',
    origin: 'https://example.test',
    bindingGeneration: 'generation-a',
    scheduleDay: '2026-07-31',
    attemptedAt: '2026-07-31T01:00:00.000Z',
    trigger: 'scheduled',
    outcome: 'success',
    durationMs: 500,
    retryCount: 0,
    ...overrides,
  };
}

export function stateWithSite(overrides: Partial<StorageState> = {}): StorageState {
  const state = createDefaultState();
  const configuredSite = site();
  return {
    ...state,
    sites: { [configuredSite.origin]: configuredSite },
    ...overrides,
  };
}
