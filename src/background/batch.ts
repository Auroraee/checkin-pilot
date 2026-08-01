import type { BatchJob, SiteConfig, StorageState } from '../shared/domain';

export function createPersistentBatch(
  sites: SiteConfig[],
  trigger: BatchJob['trigger'],
  scheduleDay: string,
  now: Date,
): BatchJob {
  const enabledSites = sites.filter((site) => site.enabled);
  return {
    id: crypto.randomUUID(),
    scheduleDay,
    trigger,
    pendingOrigins: enabledSites.map((site) => site.origin),
    bindingGenerations: Object.fromEntries(
      enabledSites.map((site) => [site.origin, site.binding.generation]),
    ),
    createdAt: now.toISOString(),
  };
}

export function nextEligibleBatchOrigin(
  batch: BatchJob,
  state: StorageState,
): string | undefined {
  return batch.pendingOrigins.find((origin) => {
    const site = state.sites[origin];
    return (
      site?.enabled === true &&
      site.binding.generation === batch.bindingGenerations[origin]
    );
  });
}

export function finishBatchOrigin(
  batch: BatchJob,
  origin: string,
  nextOriginAt?: Date,
): BatchJob | undefined {
  const pendingOrigins = batch.pendingOrigins.filter(
    (candidate) => candidate !== origin,
  );
  if (pendingOrigins.length === 0) return undefined;

  const bindingGenerations = { ...batch.bindingGenerations };
  delete bindingGenerations[origin];
  return {
    ...batch,
    pendingOrigins,
    bindingGenerations,
    ...(nextOriginAt ? { nextOriginAt: nextOriginAt.toISOString() } : {}),
  };
}

export function discardIneligibleBatchOrigins(
  batch: BatchJob,
  state: StorageState,
): BatchJob | undefined {
  const pendingOrigins = batch.pendingOrigins.filter((origin) => {
    const site = state.sites[origin];
    return (
      site?.enabled === true &&
      site.binding.generation === batch.bindingGenerations[origin]
    );
  });
  if (pendingOrigins.length === 0) return undefined;
  return {
    ...batch,
    pendingOrigins,
    bindingGenerations: Object.fromEntries(
      pendingOrigins.map((origin) => [origin, batch.bindingGenerations[origin] ?? '']),
    ),
  };
}
