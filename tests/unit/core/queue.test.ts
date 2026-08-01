import { describe, expect, it, vi } from 'vitest';
import {
  randomSerialDelayMs,
  runSerialQueue,
  selectSitesForTrigger,
} from '../../../src/core';
import { site } from './fixtures';

describe('serial site queue', () => {
  it('excludes paused sites from automatic and run-all batches but allows manual', () => {
    const paused = site({ enabled: false });
    expect(selectSitesForTrigger([paused], 'scheduled')).toEqual([]);
    expect(selectSitesForTrigger([paused], 'catchup')).toEqual([]);
    expect(selectSitesForTrigger([paused], 'run_all')).toEqual([]);
    expect(selectSitesForTrigger([paused], 'manual', paused.origin)).toEqual([paused]);
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
