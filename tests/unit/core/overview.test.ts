import { describe, expect, it } from 'vitest';
import { buildTodayOverview } from '../../../src/core/overview';
import { site, record, stateWithSite } from './fixtures';

const day = '2026-07-31';
const origin = 'https://example.test';
const retry = { id: 'retry', origin, bindingGeneration: 'generation-a', scheduleDay: day,
  dueAt: '2026-07-31T03:00:00.000Z', retryCount: 1 as const, originalTrigger: 'scheduled' as const };

describe('today overview', () => {
  it('excludes yesterday and previous bindings, then rolls over at midnight', () => {
    const state = stateWithSite({ records: [record({ bindingGeneration: 'old' }), record({ scheduleDay: '2026-07-30' })] });
    expect(buildTodayOverview(state, new Set(), day).today).toMatchObject({ total: 1, completed: 0, pending: 1 });
    state.records = [record()];
    expect(buildTodayOverview(state, new Set(), day).today.completed).toBe(1);
    expect(buildTodayOverview(state, new Set(), '2026-08-01').today).toMatchObject({ completed: 0, pending: 1 });
  });

  it('keeps retries, unverified visits and paused sites separate from success', () => {
    const paused = site({ origin: 'https://paused.test', enabled: false });
    const visit = site({ origin: 'https://visit.test', adapterId: 'visit-open' });
    const state = stateWithSite({ retries: [retry], records: [record({ outcome: 'failed' }), record({ origin: visit.origin, outcome: 'unverified' })] });
    state.sites[paused.origin] = paused;
    state.sites[visit.origin] = visit;
    const result = buildTodayOverview(state, new Set(), day);
    expect(result.today).toMatchObject({ total: 2, completed: 0, retrying: 1, failed: 0, unverified: 1, paused: 1 });
    expect(result.sites.find((s) => s.origin === origin)?.today?.retry).toEqual({ dueAt: retry.dueAt, remaining: 2 });
    state.retries = [{ ...retry, retryCount: 2 }];
    expect(buildTodayOverview(state, new Set(), day).sites.find((s) => s.origin === origin)?.today?.retry?.remaining).toBe(1);
  });

  it('ignores stale jobs and shows in-flight work', () => {
    const state = stateWithSite({ retries: [{ ...retry, bindingGeneration: 'old' }, { ...retry, scheduleDay: '2026-07-30' }] });
    expect(buildTodayOverview(state, new Set(), day).today).toMatchObject({ retrying: 0, pending: 1 });
    expect(buildTodayOverview(state, new Set([origin]), day).today.running).toBe(1);
  });

  it('keeps authentication upgrades visible even when automation was disabled', () => {
    const configured = site();
    configured.enabled = false;
    configured.binding = { ...configured.binding, state: 'action_required', actionReason: 'auth_upgrade_required' };
    const state = stateWithSite({ sites: { [origin]: configured } });
    expect(buildTodayOverview(state, new Set(), day).today).toMatchObject({ total: 1, attention: 1, paused: 0 });
  });
});
