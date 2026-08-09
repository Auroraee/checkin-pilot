import type {
  CheckinRecord,
  IdentitySource,
  SiteConfig,
  SiteView,
  StorageState,
} from '../shared/domain';
import { markPowTombstone } from './pow-ledger';

export interface RebindSiteInput {
  userId: number;
  identitySource: IdentitySource;
  generation: string;
  now?: Date;
}

export function rebindSite(site: SiteConfig, input: RebindSiteInput): SiteConfig {
  if (!Number.isInteger(input.userId) || input.userId <= 0) {
    throw new RangeError('A binding user ID must be a positive integer.');
  }
  if (!input.generation.trim() || input.generation === site.binding.generation) {
    throw new Error('A rebind requires a new non-empty binding generation.');
  }
  const now = (input.now ?? new Date()).toISOString();
  return {
    ...site,
    updatedAt: now,
    binding: {
      userId: input.userId,
      identitySource: input.identitySource,
      generation: input.generation,
      boundAt: now,
      state: 'active',
    },
  };
}

export function latestRecordForCurrentBinding(
  site: SiteConfig,
  records: readonly CheckinRecord[],
): CheckinRecord | undefined {
  return records
    .filter(
      (record) =>
        record.origin === site.origin &&
        record.bindingGeneration === site.binding.generation,
    )
    .sort((left, right) => Date.parse(right.attemptedAt) - Date.parse(left.attemptedAt))[0];
}

/**
 * True when the current binding already checked in today, so scheduled and
 * catch-up batches skip sites the user (or an earlier run) already did.
 */
export function hasSuccessfulCheckinToday(
  site: SiteConfig,
  records: readonly CheckinRecord[],
  scheduleDay: string,
): boolean {
  return records.some(
    (record) =>
      record.origin === site.origin &&
      record.bindingGeneration === site.binding.generation &&
      record.scheduleDay === scheduleDay &&
      (record.outcome === 'success' || record.outcome === 'already_checked'),
  );
}

export function buildSiteViews(state: StorageState): SiteView[] {
  return Object.values(state.sites)
    .map((site) => {
      const latestRecord = latestRecordForCurrentBinding(site, state.records);
      const view: SiteView = {
        ...site,
        isPreviousBindingRecordExcluded: state.records.some(
        (record) =>
          record.origin === site.origin &&
          record.bindingGeneration !== site.binding.generation,
        ),
      };
      if (latestRecord) view.latestRecord = latestRecord;
      return view;
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.origin.localeCompare(right.origin));
}

/**
 * Removes all site-owned state. The only survivor is today's aggregate PoW
 * ledger, marked as a tombstone to prevent remove-and-readd budget bypass.
 */
export function removeSite(
  state: StorageState,
  origin: string,
  currentScheduleDay: string,
): StorageState {
  const sites = { ...state.sites };
  delete sites[origin];
  const withoutSite: StorageState = {
    ...state,
    sites,
    records: state.records.filter((record) => record.origin !== origin),
    retries: state.retries.filter((retry) => retry.origin !== origin),
  };

  if (state.activeBatch) {
    const pendingOrigins = state.activeBatch.pendingOrigins.filter(
      (pendingOrigin) => pendingOrigin !== origin,
    );
    if (pendingOrigins.length > 0) {
      const bindingGenerations = { ...state.activeBatch.bindingGenerations };
      delete bindingGenerations[origin];
      withoutSite.activeBatch = {
        ...state.activeBatch,
        pendingOrigins,
        bindingGenerations,
      };
    } else {
      delete withoutSite.activeBatch;
    }
  }

  return markPowTombstone(withoutSite, origin, currentScheduleDay);
}
