import { describe, expect, it, vi } from 'vitest';
import {
  isStoppedForTheDay,
  randomSerialDelayMs,
  runSerialQueue,
  selectSitesForTrigger,
} from '../../../src/core';
import { site, record } from './fixtures';

describe('serial site queue', () => {
  it('excludes paused sites from automatic and run-all batches but allows manual', () => {
    const paused = site({ enabled: false });
    expect(selectSitesForTrigger([paused], 'scheduled')).toEqual([]);
    expect(selectSitesForTrigger([paused], 'catchup')).toEqual([]);
    expect(selectSitesForTrigger([paused], 'run_all')).toEqual([]);
    expect(selectSitesForTrigger([paused], 'manual', paused.origin)).toEqual([paused]);
  });

  it('keeps action_required sites in batches so a recovered login heals itself', () => {
    const base = site();
    const needsAction = site({
      binding: { ...base.binding, state: 'action_required', actionReason: 'sign_in' },
    });
    expect(selectSitesForTrigger([needsAction], 'scheduled')).toEqual([needsAction]);
    expect(selectSitesForTrigger([needsAction], 'catchup')).toEqual([needsAction]);
    expect(selectSitesForTrigger([needsAction], 'run_all')).toEqual([needsAction]);

    const pausedNeedsAction = site({
      enabled: false,
      binding: { ...base.binding, state: 'action_required', actionReason: 'sign_in' },
    });
    expect(selectSitesForTrigger([pausedNeedsAction], 'scheduled')).toEqual([]);
  });

  it('stops a same-origin-refresh sign-in site for the rest of its schedule day', () => {
    const base = site({
      authMode: 'same-origin-refresh',
      binding: {
        ...site().binding,
        identitySource: 'refresh',
        state: 'action_required',
        actionReason: 'sign_in',
      },
    });
    const today = '2026-08-14';
    const stopped = record({
      origin: base.origin,
      scheduleDay: today,
      outcome: 'action_required',
      actionReason: 'sign_in',
    });
    expect(isStoppedForTheDay(base, [stopped], today)).toBe(true);
    // A fresh day has no record: the next scheduled batch retries once.
    expect(isStoppedForTheDay(base, [], '2026-08-15')).toBe(false);
    // Legacy-session sign-in is not stopped-today; it pauses on first 401
    // via auth_upgrade_required instead.
    const legacy = site({
      binding: {
        ...site().binding,
        state: 'action_required',
        actionReason: 'sign_in',
      },
    });
    expect(isStoppedForTheDay(legacy, [stopped], today)).toBe(false);
  });

  it('keeps auth-upgrade-required sites out of every batch until updated', () => {
    const base = site({
      enabled: false,
      binding: {
        ...site().binding,
        state: 'action_required',
        actionReason: 'auth_upgrade_required',
      },
    });
    expect(isStoppedForTheDay(base, [], '2026-08-14')).toBe(true);
    expect(isStoppedForTheDay(base, [], '2026-08-15')).toBe(true);
  });

  it('uses bounded 5 to 15 second spacing', () => {
    expect(randomSerialDelayMs(() => 0)).toBe(5_000);
    expect(randomSerialDelayMs(() => 1)).toBe(15_000);
  });

  it('never overlaps work and continues after a site failure', async () => {
    const sites = [
      site({ origin: 'https://a.test', createdAt: '2026-01-01T00:00:00.000Z' }),
      site({ origin: 'https://b.test', createdAt: '2026-01-02T00:00:00.000Z' }),
      site({ origin: 'https://c.test', createdAt: '2026-01-03T00:00:00.000Z' }),
    ];
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    const delay = vi.fn(async () => undefined);
    const results = await runSerialQueue(sites, {
      random: () => 0,
      delay,
      work: async (configuredSite) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls.push(configuredSite.origin);
        active -= 1;
        if (configuredSite.origin === 'https://b.test') throw new Error('redacted');
        return configuredSite.origin;
      },
    });
    expect(maxActive).toBe(1);
    expect(calls).toEqual(sites.map((configuredSite) => configuredSite.origin));
    expect(delay).toHaveBeenCalledTimes(2);
    expect(results[1]?.error).toBeInstanceOf(Error);
    expect(results[2]?.result).toBe('https://c.test');
  });
});
