import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDefaultState, STORAGE_KEY } from '../../src/shared/constants';
import type {
  CheckinRecord,
  SiteConfig,
  StorageState,
} from '../../src/shared/domain';
import { localScheduleDay } from '../../src/core/time';
import { modernAuthScript } from '../../src/auth/refresh-script';
import { MockHarness, SENTINEL_TOKEN } from './harness';

const browserRef = vi.hoisted(() => ({ current: undefined as never }));
vi.mock('wxt/browser', () => ({ browser: browserRef.current }));

const harness = new MockHarness();
browserRef.current = harness.browser.browser as never;

const RUNANYTIME = 'https://runanytime.hxi.me';
const PANEL = 'https://panel.example';
const TODAY = localScheduleDay();

function site(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    origin: PANEL,
    label: 'panel.example',
    platform: 'new-api',
    adapterId: 'new-api',
    authMode: 'legacy-session',
    supportLevel: 'detected',
    enabled: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    capabilities: { checkin: true, statusEndpoint: true },
    binding: {
      userId: 7,
      identitySource: 'uid',
      generation: 'generation-a',
      boundAt: '2026-08-01T00:00:00.000Z',
      state: 'active',
    },
    ...overrides,
  };
}

function record(overrides: Partial<CheckinRecord> = {}): CheckinRecord {
  return {
    id: 'record-1',
    origin: PANEL,
    bindingGeneration: 'generation-a',
    scheduleDay: TODAY,
    attemptedAt: new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      new Date().getDate(),
      1,
      0,
    ).toISOString(),
    trigger: 'manual',
    outcome: 'action_required',
    durationMs: 100,
    retryCount: 0,
    ...overrides,
  };
}

async function seedState(state: StorageState): Promise<void> {
  await harness.browser.browser.storage.local.set({ [STORAGE_KEY]: state });
}

function seededState(sites: SiteConfig[]): StorageState {
  const state = createDefaultState();
  for (const configuredSite of sites) {
    state.sites[configuredSite.origin] = configuredSite;
  }
  return state;
}

/**
 * Starts the background first (with no sites, so any due schedule completes
 * without touching real sites), lets the startup scheduling settle, then
 * seeds the site configuration.
 */
async function startWith(sites: SiteConfig[], serverConfig: Record<string, unknown> = {}): Promise<void> {
  harness.reset();
  harness.server.setConfig(serverConfig as never);
  harness.browser.grant(RUNANYTIME);
  harness.browser.grant(PANEL);
  await harness.startBackground();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await seedState(seededState(sites));
}

const successResponse = (response: unknown) => {
  expect((response as { ok: boolean }).ok).toBe(true);
};

function headerValue(request: { headers: Record<string, string> }, name: string): string | undefined {
  const lower = name.toLowerCase();
  const entry = Object.entries(request.headers).find(([key]) => key.toLowerCase() === lower);
  return entry?.[1];
}

beforeAll(() => {
  harness.reset();
  harness.server.setConfig({});
});

afterEach(() => {
  harness.reset();
  vi.useRealTimers();
});

describe('legacy-session sites', () => {
  it('checks in through the browser session without any page tab', async () => {
    await startWith(
      [site()],
      {
        status: { success: true, data: { checkin_enabled: true, turnstile_check: false, pow_enabled: false, pow_mode: 'unknown' } },
      },
    );
    const response = await harness.manualCheckin(PANEL);
    successResponse(response);
    expect((response as { outcome: { code: string } }).outcome.code).toBe('success');
    expect(harness.browser.createdTabs).toEqual([]);
    const submit = harness.server.requests.find(
      (request) => request.method === 'POST' && request.url.startsWith('/api/user/checkin'),
    );
    expect(headerValue(submit ?? { headers: {} }, 'New-Api-User')).toBe('7');
    expect(headerValue(submit ?? { headers: {} }, 'Authorization')).toBeUndefined();
    harness.assertSentinelConfined();
  });

  it('pauses a legacy site on its first 401 and prompts the login-method update', async () => {
    await startWith([site()], { checkin: 'needs_login' });
    const response = await harness.manualCheckin(PANEL);
    const outcome = (response as { outcome: { code: string; actionReason?: string } }).outcome;
    expect(outcome.code).toBe('action_required');
    expect(outcome.actionReason).toBe('auth_upgrade_required');
    const stored = harness.state as StorageState;
    const paused = stored.sites[PANEL];
    expect(paused?.enabled).toBe(false);
    expect(paused?.binding.state).toBe('action_required');
    expect(paused?.binding.actionReason).toBe('auth_upgrade_required');
    expect(
      harness.browser.notifications.some(
        (notification) => notification.message.includes('更新当前网站'),
      ),
    ).toBe(true);
  });
});

describe('same-origin-refresh (modern bearer) sites', () => {
  it('checks in inside a temporary background tab and closes it afterwards', async () => {
    await startWith(
      [site({ authMode: 'same-origin-refresh', adapterId: 'new-api', binding: { ...site().binding, identitySource: 'refresh' } })],
      { status: { success: true, data: { checkin_enabled: true, turnstile_check: false, pow_enabled: false, pow_mode: 'unknown' } } },
    );
    const response = await harness.manualCheckin(PANEL);
    successResponse(response);
    expect((response as { outcome: { code: string } }).outcome.code).toBe('success');
    // A temporary tab was created inactive and then removed.
    expect(harness.browser.createdTabs).toEqual([{ url: PANEL, active: false }]);
    expect(harness.browser.removedTabs).toHaveLength(1);
    expect(harness.browser.tabsById.size).toBe(0);
    // The refresh happened in the page world with the sentinel bearer token.
    const refresh = harness.server.requests.find((request) => request.url === '/api/user/auth/refresh');
    expect(refresh?.from).toBe('page');
    expect(refresh?.method).toBe('POST');
    const submit = harness.server.requests.find(
      (request) => request.method === 'POST' && request.url.startsWith('/api/user/checkin'),
    );
    expect(submit?.from).toBe('page');
    expect(headerValue(submit ?? { headers: {} }, 'Authorization')).toBe(`Bearer ${SENTINEL_TOKEN}`);
    expect((response as { outcome: { reward?: string } }).outcome.reward).toBe('3 credits');
    harness.assertSentinelConfined();
  });

  it('reuses an existing user tab and never closes it', async () => {
    await startWith(
      [site({ authMode: 'same-origin-refresh', binding: { ...site().binding, identitySource: 'refresh' } })],
      { status: { success: true, data: { checkin_enabled: true, turnstile_check: false, pow_enabled: false, pow_mode: 'unknown' } } },
    );
    const userTab = harness.browser.seedTab(`${PANEL}/console/personal`);
    const response = await harness.manualCheckin(PANEL);
    successResponse(response);
    expect((response as { outcome: { code: string } }).outcome.code).toBe('success');
    // No new tab was created and the user's tab survives.
    expect(harness.browser.createdTabs).toEqual([]);
    expect(harness.browser.removedTabs).toEqual([]);
    expect(harness.browser.tabsById.get(userTab.id)?.url).toBe(`${PANEL}/console/personal`);
    harness.assertSentinelConfined();
  });

  it('marks an account change as action required and never submits', async () => {
    await startWith(
      [site({ authMode: 'same-origin-refresh', binding: { ...site().binding, identitySource: 'refresh' } })],
      { refreshAccount: 999 },
    );
    const response = await harness.manualCheckin(PANEL);
    const outcome = (response as { outcome: { code: string; actionReason: string } }).outcome;
    expect(outcome.code).toBe('action_required');
    expect(outcome.actionReason).toBe('account_changed');
    expect(
      harness.server.requests.some(
        (request) => request.method === 'POST' && request.url.startsWith('/api/user/checkin'),
      ),
    ).toBe(false);
    const stored = harness.state as StorageState;
    expect(stored.sites[PANEL]?.binding.state).toBe('action_required');
    expect(stored.sites[PANEL]?.binding.actionReason).toBe('account_changed');
    harness.assertSentinelConfined();
  });

  it('stops for the day on refresh 401, notifies once and skips run-all', async () => {
    await startWith(
      [site({ authMode: 'same-origin-refresh', binding: { ...site().binding, identitySource: 'refresh' } })],
      { refresh: 'needs_login' },
    );
    const first = await harness.manualCheckin(PANEL);
    expect((first as { outcome: { actionReason: string } }).outcome.actionReason).toBe('sign_in');
    const notificationsAfterFirst = harness.browser.notifications.length;
    expect(notificationsAfterFirst).toBeGreaterThan(0);

    const second = await harness.manualCheckin(PANEL);
    expect((second as { outcome: { actionReason: string } }).outcome.actionReason).toBe('sign_in');
    // Only one notification per day for the same condition.
    expect(harness.browser.notifications.length).toBe(notificationsAfterFirst);

    // The site is stopped for the day: run-all completes without retrying it.
    const refreshCallsBefore = harness.server.requests.filter(
      (request) => request.url === '/api/user/auth/refresh',
    ).length;
    await harness.runAll();
    const refreshCallsAfter = harness.server.requests.filter(
      (request) => request.url === '/api/user/auth/refresh',
    ).length;
    expect(refreshCallsAfter).toBe(refreshCallsBefore);
    harness.assertSentinelConfined();
  });

  it('reports a runtime refresh 404 as unsupported instead of guessing', async () => {
    await startWith(
      [site({ authMode: 'same-origin-refresh', binding: { ...site().binding, identitySource: 'refresh' } })],
      { refresh: 'legacy_only' },
    );
    const response = await harness.manualCheckin(PANEL);
    expect((response as { outcome: { code: string; errorCode: string } }).outcome).toMatchObject({
      code: 'unsupported',
      errorCode: 'unsupported_protocol',
    });
    harness.assertSentinelConfined();
  });

  it('supports GET-only refresh deployments via the method fallback', async () => {
    await startWith(
      [site({ authMode: 'same-origin-refresh', binding: { ...site().binding, identitySource: 'refresh' } })],
      {
        refresh: 'get_only',
        status: { success: true, data: { checkin_enabled: true, turnstile_check: false, pow_enabled: false, pow_mode: 'unknown' } },
      },
    );
    const response = await harness.manualCheckin(PANEL);
    successResponse(response);
    expect((response as { outcome: { code: string } }).outcome.code).toBe('success');
    const refreshCalls = harness.server.requests.filter(
      (request) => request.url === '/api/user/auth/refresh',
    );
    // POST 404 first, then the GET fallback succeeds.
    expect(refreshCalls.map((request) => request.method)).toEqual(['POST', 'GET']);
    harness.assertSentinelConfined();
  });
});

describe('runanytime private PoW', () => {
  const runanytimeSite = () =>
    site({
      origin: RUNANYTIME,
      label: 'runanytime.hxi.me',
      platform: 'runanytime',
      adapterId: 'runanytime',
      authMode: 'same-origin-refresh',
      supportLevel: 'verified',
      binding: { ...site().binding, identitySource: 'refresh' },
    });

  it('solves the challenge through the offscreen solver in one injection', async () => {
    await startWith([runanytimeSite()]);
    const response = await harness.manualCheckin(RUNANYTIME);
    successResponse(response);
    expect((response as { outcome: { reward?: string } }).outcome.reward).toBe('3 credits');
    // Only prefix/difficulty/challengeId cross to the solver; the nonce comes back.
    const solveMessage = harness.browser.messageLog.find(
      (entry) =>
        (entry.message as { type?: string }).type === 'pow:solve' &&
        (entry.message as { target?: string }).target === 'background',
    );
    expect(solveMessage?.from).toBe('page');
    const payload = solveMessage?.message as {
      prefix: string;
      difficulty: number;
      taskId: string;
    };
    expect(payload.prefix).toBe('private-prefix:');
    expect(payload.difficulty).toBe(18);
    expect(payload.taskId.length).toBeGreaterThan(0);
    const submit = harness.server.requests.find(
      (request) => request.method === 'POST' && request.url.startsWith('/api/user/checkin'),
    );
    expect(submit?.url).toContain('pow_challenge=challenge-1');
    expect(submit?.url).toContain('pow_nonce=0000000a');
    const day = (harness.state as StorageState).records[0]?.scheduleDay ?? TODAY;
    const ledger = (harness.state as StorageState).powLedgers[`${RUNANYTIME}\n${day}`];
    expect(ledger?.challengesUsed).toBe(1);
    expect(ledger?.workerMsUsed).toBe(25);
    harness.assertSentinelConfined();
  });

  it('exhausts the daily budget after two worker timeouts', async () => {
    await startWith([runanytimeSite()]);
    harness.browser.powBehavior = 'timeout';
    const response = await harness.manualCheckin(RUNANYTIME);
    expect((response as { outcome: unknown }).outcome).toMatchObject({
      code: 'action_required',
      actionReason: 'unknown_challenge',
      errorCode: 'pow_budget_exhausted',
      retryable: false,
    });
    const day = (harness.state as StorageState).records[0]?.scheduleDay ?? TODAY;
    const ledger = (harness.state as StorageState).powLedgers[`${RUNANYTIME}\n${day}`];
    expect(ledger?.challengesUsed).toBe(2);
    expect(ledger?.workerMsUsed).toBe(24_000);
    harness.assertSentinelConfined();
  });

  it('refuses to start once the daily challenge budget is already spent', async () => {
    harness.reset();
    harness.browser.grant(RUNANYTIME);
    await harness.startBackground();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const state = seededState([runanytimeSite()]);
    state.powLedgers[`${RUNANYTIME}\n${TODAY}`] = {
      origin: RUNANYTIME,
      scheduleDay: TODAY,
      challengesUsed: 2,
      workerMsUsed: 24_000,
      removedSiteTombstone: false,
    };
    await seedState(state);
    const response = await harness.manualCheckin(RUNANYTIME);
    expect((response as { outcome: unknown }).outcome).toMatchObject({
      code: 'action_required',
      actionReason: 'unknown_challenge',
      errorCode: 'pow_budget_exhausted',
    });
    harness.assertSentinelConfined();
  });

  it('marks unknown private challenges as not automatable', async () => {
    await startWith([runanytimeSite()], {
      status: {
        success: true,
        data: { checkin_enabled: true, turnstile_check: true, pow_enabled: true, pow_mode: 'unknown' },
      },
    });
    const response = await harness.manualCheckin(RUNANYTIME);
    expect((response as { outcome: { actionReason: string } }).outcome.actionReason).toBe('unknown_challenge');
    expect(
      harness.server.requests.some((request) => request.url.includes('/api/user/pow/challenge')),
    ).toBe(false);
    harness.assertSentinelConfined();
  });

  it('requires manual handling for supplement/fallback Turnstile sites', async () => {
    await startWith([runanytimeSite()], {
      status: {
        success: true,
        data: { checkin_enabled: true, turnstile_check: true, pow_enabled: true, pow_mode: 'supplement' },
      },
    });
    const response = await harness.manualCheckin(RUNANYTIME);
    expect((response as { outcome: { actionReason: string } }).outcome.actionReason).toBe('turnstile');
    harness.assertSentinelConfined();
  });

  it('confirms success when a Turnstile site already checked in today', async () => {
    await startWith([runanytimeSite()], {
      status: {
        success: true,
        data: { checkin_enabled: true, turnstile_check: true, pow_enabled: true, pow_mode: 'supplement' },
      },
      checkin: 'checked',
    });
    const response = await harness.manualCheckin(RUNANYTIME);
    expect((response as { outcome: { code: string } }).outcome.code).toBe('already_checked');
    harness.assertSentinelConfined();
  });
});

describe('visit mode', () => {
  it('returns an unverified terminal result and never notifies', async () => {
    await startWith([
      site({
        adapterId: 'visit-open',
        authMode: 'none',
        platform: 'generic',
        capabilities: { checkin: true, statusEndpoint: false },
      }),
    ]);
    vi.useFakeTimers();
    const promise = harness.manualCheckin(PANEL);
    await vi.advanceTimersByTimeAsync(16_000);
    const response = await promise;
    expect((response as { outcome: { code: string; retryable: boolean } }).outcome).toEqual({
      code: 'unverified',
      retryable: false,
    });
    expect(harness.browser.notifications).toEqual([]);
    const stored = harness.state as StorageState;
    expect(stored.records[0]?.outcome).toBe('unverified');
    vi.useRealTimers();
  });
});

describe('v1 to v2 migration', () => {
  function v1Site(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      origin: PANEL,
      label: 'panel.example',
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

  it('migrates losslessly, pauses runanytime and notifies once', async () => {
    harness.reset();
    harness.browser.grant(RUNANYTIME);
    harness.browser.grant(PANEL);
    const attemptedAt = new Date(
      new Date().getFullYear(),
      new Date().getMonth(),
      new Date().getDate(),
      1,
      0,
    ).toISOString();
    const v1 = {
      schemaVersion: 1,
      settings: { windowStartMinutes: 8 * 60, windowEndMinutes: 10 * 60, notifyOnSuccess: true },
      sites: {
        [RUNANYTIME]: v1Site({
          origin: RUNANYTIME,
          platform: 'runanytime',
          adapterId: 'runanytime-pow',
          supportLevel: 'verified',
          enabled: true,
          binding: {
            userId: 7,
            identitySource: 'uid',
            generation: 'generation-r',
            boundAt: '2026-07-01T00:00:00.000Z',
            state: 'active',
          },
        }),
        [PANEL]: v1Site({ enabled: false }),
        'https://visit.example': v1Site({
          origin: 'https://visit.example',
          platform: 'generic',
          adapterId: 'visit-open',
          capabilities: { checkin: true, statusEndpoint: false },
        }),
      },
      records: [
        record({
          origin: RUNANYTIME,
          bindingGeneration: 'generation-r',
          id: 'keep-me',
          attemptedAt,
        }),
      ],
      schedules: {
        [TODAY]: { scheduleDay: TODAY, scheduledAt: attemptedAt, state: 'complete' },
      },
      retries: [],
      powLedgers: {
        [`${RUNANYTIME}\n${TODAY}`]: {
          origin: RUNANYTIME,
          scheduleDay: TODAY,
          challengesUsed: 1,
          workerMsUsed: 5_000,
          removedSiteTombstone: false,
        },
      },
    };
    await seedState(v1 as never);
    await harness.startBackground();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const state = harness.state as StorageState;
    expect(state.schemaVersion).toBe(2);
    expect(state.upgrade.authUpgradeNoticeSent).toBe(true);
    // runanytime: paused + upgrade notice, modern auth mode.
    const runanytime = state.sites[RUNANYTIME];
    expect(runanytime?.adapterId).toBe('runanytime');
    expect(runanytime?.authMode).toBe('same-origin-refresh');
    expect(runanytime?.enabled).toBe(false);
    expect(runanytime?.binding.state).toBe('action_required');
    expect(runanytime?.binding.actionReason).toBe('auth_upgrade_required');
    expect(runanytime?.binding.generation).toBe('generation-r');
    // other sites keep legacy/none auth modes.
    expect(state.sites[PANEL]?.authMode).toBe('legacy-session');
    expect(state.sites['https://visit.example']?.authMode).toBe('none');
    expect(state.sites[PANEL]?.enabled).toBe(false);
    // history and PoW ledger survive untouched.
    expect(state.records.find((entry) => entry.id === 'keep-me')?.origin).toBe(RUNANYTIME);
    expect(Object.values(state.powLedgers)[0]?.workerMsUsed).toBe(5_000);
    // settings survive.
    expect(state.settings.notifyOnSuccess).toBe(true);
    // one-time upgrade notice.
    expect(
      harness.browser.notifications.filter((notification) => notification.id === 'checkin-pilot:auth-upgrade'),
    ).toHaveLength(1);
  });

  it('does not repeat the upgrade notification on later startups', async () => {
    harness.reset();
    harness.browser.grant(RUNANYTIME);
    await seedState(v1StateWithUpgradeNotice() as never);
    await harness.startBackground();
    await harness.startBackground();
    expect(
      harness.browser.notifications.filter((notification) => notification.id === 'checkin-pilot:auth-upgrade'),
    ).toHaveLength(0);
  });
});

function v1StateWithUpgradeNotice(): unknown {
  return {
    schemaVersion: 2,
    settings: { windowStartMinutes: 8 * 60, windowEndMinutes: 10 * 60, notifyOnSuccess: false },
    sites: {
      [RUNANYTIME]: {
        origin: RUNANYTIME,
        label: 'runanytime.hxi.me',
        platform: 'runanytime',
        adapterId: 'runanytime',
        authMode: 'same-origin-refresh',
        supportLevel: 'verified',
        enabled: false,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
        capabilities: { checkin: true, statusEndpoint: true },
        binding: {
          userId: 7,
          identitySource: 'refresh',
          generation: 'generation-r',
          boundAt: '2026-07-01T00:00:00.000Z',
          state: 'action_required',
          actionReason: 'auth_upgrade_required',
        },
      },
    },
    records: [],
    schedules: {},
    retries: [],
    powLedgers: {},
    upgrade: { authUpgradeNoticeSent: true },
  };
}

describe('probing and enrollment', () => {
  it('probes modern-first on the user tab and enrolls with the refresh identity', async () => {
    harness.reset();
    harness.browser.grant(PANEL);
    await seedState(createDefaultState());
    await harness.startBackground();
    const userTab = harness.browser.seedTab(`${PANEL}/console/personal`);
    harness.server.setConfig({
      status: { success: true, data: { checkin_enabled: true, turnstile_check: false, pow_enabled: false, pow_mode: 'unknown' } },
    } as never);

    const probe = await harness.probe(PANEL, { userId: 7, tabId: userTab.id });
    const report = (probe as { report: { supported: boolean; userId: number; identitySource: string; authMode: string } }).report;
    expect(report.supported).toBe(true);
    expect(report.userId).toBe(7);
    expect(report.identitySource).toBe('refresh');
    expect(report.authMode).toBe('same-origin-refresh');
    // The user tab was reused, not duplicated.
    expect(harness.browser.createdTabs).toEqual([]);

    const confirm = await harness.confirm({
      origin: PANEL,
      label: 'panel.example',
      userId: 7,
      identitySource: 'refresh',
      adapterId: 'new-api',
      platform: 'new-api',
      authMode: 'same-origin-refresh',
      supportLevel: 'detected',
      capabilities: { checkin: true, statusEndpoint: true },
    });
    successResponse(confirm);
    const stored = harness.state as StorageState;
    expect(stored.sites[PANEL]?.authMode).toBe('same-origin-refresh');
    expect(stored.sites[PANEL]?.binding.identitySource).toBe('refresh');
    harness.assertSentinelConfined();
  });

  it('upgrades an existing site in place and re-enables it', async () => {
    await startWith(
      [
        site({
          enabled: false,
          binding: { ...site().binding, state: 'action_required', actionReason: 'auth_upgrade_required' },
        }),
      ],
      { status: { success: true, data: { checkin_enabled: true, turnstile_check: false, pow_enabled: false, pow_mode: 'unknown' } } },
    );
    const tab = harness.browser.seedTab(`${PANEL}/`);
    const probe = await harness.probe(PANEL, { tabId: tab.id });
    const report = (probe as { report: { supported: boolean; authMode: string } }).report;
    expect(report.supported).toBe(true);
    expect(report.authMode).toBe('same-origin-refresh');
    const upgrade = await harness.upgrade({
      origin: PANEL,
      label: 'panel.example',
      userId: 7,
      identitySource: 'refresh',
      adapterId: 'new-api',
      platform: 'new-api',
      authMode: 'same-origin-refresh',
      supportLevel: 'detected',
      capabilities: { checkin: true, statusEndpoint: true },
    });
    successResponse(upgrade);
    const stored = harness.state as StorageState;
    expect(stored.sites[PANEL]?.authMode).toBe('same-origin-refresh');
    expect(stored.sites[PANEL]?.enabled).toBe(true);
    expect(stored.sites[PANEL]?.binding.state).toBe('active');
    expect(stored.sites[PANEL]?.binding.generation).toBe('generation-a');
  });

  it('refuses an upgrade when the signed-in account changed', async () => {
    await startWith([site()], {
      refreshAccount: 9,
      status: { success: true, data: { checkin_enabled: true, turnstile_check: false, pow_enabled: false, pow_mode: 'unknown' } },
    });
    const tab = harness.browser.seedTab(`${PANEL}/`);
    const probe = await harness.probe(PANEL, { tabId: tab.id });
    const report = (probe as { report: { supported: boolean; userId: number } }).report;
    expect(report.supported).toBe(true);
    expect(report.userId).toBe(9);
    const upgrade = await harness.upgrade({
      origin: PANEL,
      label: 'panel.example',
      userId: 9,
      identitySource: 'refresh',
      adapterId: 'new-api',
      platform: 'new-api',
      authMode: 'same-origin-refresh',
      supportLevel: 'detected',
      capabilities: { checkin: true, statusEndpoint: true },
    });
    expect((upgrade as { ok: boolean; errorCode: string }).ok).toBe(false);
    expect((upgrade as { errorCode: string }).errorCode).toBe('account_changed');
  });

  it('falls back to legacy probing only when refresh returns 404', async () => {
    harness.reset();
    harness.browser.grant(PANEL);
    await seedState(createDefaultState());
    await harness.startBackground();
    const tab = harness.browser.seedTab(`${PANEL}/`);
    harness.server.setConfig({ refresh: 'legacy_only' } as never);
    const probe = await harness.probe(PANEL, { userId: 7, identitySource: 'uid', tabId: tab.id });
    const report = (probe as { report: { supported: boolean; authMode: string; identitySource: string } }).report;
    expect(report.supported).toBe(true);
    expect(report.authMode).toBe('legacy-session');
    expect(report.identitySource).toBe('uid');
  });

  it('reports a refresh 401 probe as needing login, not incompatible', async () => {
    harness.reset();
    harness.browser.grant(PANEL);
    await seedState(createDefaultState());
    await harness.startBackground();
    const tab = harness.browser.seedTab(`${PANEL}/`);
    harness.server.setConfig({ refresh: 'needs_login' } as never);
    const probe = await harness.probe(PANEL, { userId: 7, tabId: tab.id });
    const report = (probe as { report: { supported: boolean; reason: string } }).report;
    expect(report.supported).toBe(false);
    expect(report.reason).toBe('sign_in');
  });
});

describe('navigation races', () => {
  it('fails cleanly and still cleans up the temporary tab', async () => {
    await startWith(
      [site({ authMode: 'same-origin-refresh', binding: { ...site().binding, identitySource: 'refresh' } })],
      { status: { success: true, data: { checkin_enabled: true, turnstile_check: false, pow_enabled: false, pow_mode: 'unknown' } } },
    );
    harness.browser.tabGone = true;
    const response = await harness.manualCheckin(PANEL);
    expect((response as { outcome: { code: string; errorCode: string } }).outcome).toMatchObject({
      code: 'failed',
      errorCode: 'unknown',
      retryable: false,
    });
    // The owned temporary tab is still removed in the cleanup path.
    expect(harness.browser.createdTabs).toHaveLength(1);
    expect(harness.browser.tabsById.size).toBe(0);
    harness.assertSentinelConfined();
  });
});

describe('injected script serialization', () => {
  it('is fully self-contained when re-evaluated from its source text', async () => {
    harness.reset();
    harness.server.setConfig({
      refreshAccount: 7,
      status: { success: true, data: { checkin_enabled: true, turnstile_check: false, pow_enabled: false, pow_mode: 'unknown' } },
    } as never);
    // executeScript serializes the function: re-evaluate it from toString()
    // with only built-ins available (no module scope).
    const serialized = modernAuthScript.toString();
    expect(serialized).not.toContain('import ');
    const deserialized = new Function(`return (${serialized})`)() as typeof modernAuthScript;
    const previousFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = (input: RequestInfo | URL, init?: RequestInit) =>
      harness.server.fetch(new URL(String(input), `${PANEL}/`), init);
    try {
      const result = await deserialized({
        op: 'probe',
        month: '2026-08',
        userId: 7,
        powEnabled: false,
        powMode: 'unknown',
        turnstileCheck: false,
        maxPowAttempts: 0,
        powMaxMs: 0,
        tabId: 1,
      });
      expect(result).toMatchObject({ kind: 'probe', userId: 7, checkedInToday: false });
    } finally {
      (globalThis as any).fetch = previousFetch;
    }
    harness.assertSentinelConfined();
  });
});
