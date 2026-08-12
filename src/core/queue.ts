import {
  SERIAL_DELAY_MAX_MS,
  SERIAL_DELAY_MIN_MS,
} from '../shared/constants';
import type { SiteConfig, TriggerKind } from '../shared/domain';

export interface SerialQueueOptions<T> {
  work: (site: SiteConfig, index: number) => Promise<T>;
  delay?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  isCancelled?: () => boolean;
}

export interface SerialQueueItem<T> {
  site: SiteConfig;
  result?: T;
  error?: unknown;
}

export function isSiteEligibleForTrigger(site: SiteConfig, trigger: TriggerKind): boolean {
  // An action_required binding still joins batches: one bounded attempt per
  // run either confirms the user fixed it (state recovers to active) or
  // leaves the state unchanged. Skipping would strand recovered sites.
  if (trigger === 'manual') return true;
  if (trigger === 'retry') return true;
  return site.enabled;
}

export function selectSitesForTrigger(
  sites: Iterable<SiteConfig>,
  trigger: TriggerKind,
  manualOrigin?: string,
): SiteConfig[] {
  return [...sites]
    .filter((site) => {
      if (trigger === 'manual' && manualOrigin && site.origin !== manualOrigin) return false;
      return isSiteEligibleForTrigger(site, trigger);
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.origin.localeCompare(right.origin));
}

export function randomSerialDelayMs(random: () => number = Math.random): number {
  const sample = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);
  return Math.floor(
    SERIAL_DELAY_MIN_MS + sample * (SERIAL_DELAY_MAX_MS - SERIAL_DELAY_MIN_MS + 1),
  );
}

const defaultDelay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Runs one site at a time and continues after an individual failure. */
export async function runSerialQueue<T>(
  sites: readonly SiteConfig[],
  options: SerialQueueOptions<T>,
): Promise<SerialQueueItem<T>[]> {
  const results: SerialQueueItem<T>[] = [];
  const delay = options.delay ?? defaultDelay;
  const random = options.random ?? Math.random;

  for (let index = 0; index < sites.length; index += 1) {
    if (options.isCancelled?.()) break;
    const site = sites[index];
    if (!site) continue;
    try {
      results.push({ site, result: await options.work(site, index) });
    } catch (error) {
      results.push({ site, error });
    }

    if (index < sites.length - 1 && !options.isCancelled?.()) {
      await delay(randomSerialDelayMs(random));
    }
  }

  return results;
}
