import type { SiteToday, SiteView, StorageState, TodaySummary } from '../shared/domain';
import { RETRY_DELAYS_MS } from '../shared/constants';
import { buildSiteViews } from './sites';
import { localScheduleDay } from './time';

/** All visible counts use the current binding and local schedule day. */
export function buildTodayOverview(
  state: StorageState,
  runningOrigins: ReadonlySet<string> = new Set(),
  scheduleDay = localScheduleDay(),
): { sites: SiteView[]; today: TodaySummary } {
  const today: TodaySummary = {
    total: 0, completed: 0, retrying: 0, attention: 0, failed: 0,
    unverified: 0, pending: 0, running: 0, paused: 0,
  };
  const sites = buildSiteViews(state).map((site) => {
    const record = site.latestRecord?.scheduleDay === scheduleDay ? site.latestRecord : undefined;
    const job = state.retries.filter((retry) =>
      retry.origin === site.origin && retry.bindingGeneration === site.binding.generation &&
      retry.scheduleDay === scheduleDay && Number.isFinite(Date.parse(retry.dueAt)),
    ).sort((a, b) => b.retryCount - a.retryCount)[0];
    let status: SiteToday['status'];
    if (runningOrigins.has(site.origin)) status = 'running';
    else if (site.binding.state === 'action_required') status = 'attention';
    else if (!site.enabled) status = 'paused';
    else if (record?.outcome === 'success' || record?.outcome === 'already_checked') status = 'completed';
    else if (record?.outcome === 'action_required') status = 'attention';
    else if (job) status = 'retrying';
    else if (record?.outcome === 'failed' || record?.outcome === 'unsupported') status = 'failed';
    else if (record?.outcome === 'unverified') status = 'unverified';
    else status = 'pending';
    const view: SiteToday = { status };
    if (record) view.record = record;
    if (job && status === 'retrying') {
      view.retry = { dueAt: job.dueAt, remaining: RETRY_DELAYS_MS.length - job.retryCount + 1 };
    }
    today[status] += 1;
    if (status !== 'paused') today.total += 1;
    return { ...site, today: view };
  });
  return { sites, today };
}
