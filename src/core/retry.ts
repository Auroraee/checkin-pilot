import { RETRY_DELAYS_MS } from '../shared/constants';
import type {
  NormalizedOutcome,
  RetryJob,
  StorageState,
  TriggerKind,
} from '../shared/domain';
import { localScheduleDay } from './time';

const RETRYABLE_ERROR_CODES = new Set(['network', 'rate_limited', 'server_error']);

export interface CreateRetryJobInput {
  origin: string;
  bindingGeneration: string;
  scheduleDay: string;
  completedRetries: 0 | 1;
  originalTrigger: Exclude<TriggerKind, 'retry'>;
  outcome: NormalizedOutcome;
  now?: Date;
  id?: string;
}

export function isRetryableOutcome(outcome: NormalizedOutcome): boolean {
  return (
    outcome.retryable &&
    outcome.errorCode !== undefined &&
    RETRYABLE_ERROR_CODES.has(outcome.errorCode)
  );
}

export function createRetryJob(input: CreateRetryJobInput): RetryJob | undefined {
  if (!isRetryableOutcome(input.outcome)) return undefined;

  const now = input.now ?? new Date();
  if (localScheduleDay(now) !== input.scheduleDay) return undefined;
  const retryCount = (input.completedRetries + 1) as 1 | 2;
  const defaultDelay = RETRY_DELAYS_MS[input.completedRetries];
  const retryAfter = Math.max(0, input.outcome.retryAfterMs ?? 0);
  const dueAt = new Date(now.getTime() + Math.max(defaultDelay, retryAfter));
  if (localScheduleDay(dueAt) !== input.scheduleDay) return undefined;

  return {
    id:
      input.id ??
      `${encodeURIComponent(input.origin)}:${input.scheduleDay}:${input.bindingGeneration}:${retryCount}`,
    origin: input.origin,
    bindingGeneration: input.bindingGeneration,
    scheduleDay: input.scheduleDay,
    retryCount,
    dueAt: dueAt.toISOString(),
    originalTrigger: input.originalTrigger,
  };
}

export function isRetryJobDue(job: RetryJob, now: Date = new Date()): boolean {
  if (localScheduleDay(now) !== job.scheduleDay) return false;
  const dueAt = new Date(job.dueAt);
  return Number.isFinite(dueAt.getTime()) && now.getTime() >= dueAt.getTime();
}

/** A retry always performs status first; only a proven unchecked result permits the POST. */
export function shouldAttemptRetryAfterStatus(
  status: NormalizedOutcome | { checkedInToday: boolean },
): boolean {
  if ('checkedInToday' in status) return status.checkedInToday === false;
  if (status.code === 'already_checked' || status.code === 'success') return false;
  return false;
}

/** Removes expired, deleted-site, stale-binding and duplicate retry jobs. */
export function dropInvalidRetries(
  state: StorageState,
  currentScheduleDay: string,
): RetryJob[] {
  const seen = new Set<string>();
  return state.retries.filter((job) => {
    const logicalKey = `${job.origin}\n${job.bindingGeneration}\n${job.scheduleDay}\n${job.retryCount}`;
    if (job.scheduleDay !== currentScheduleDay || seen.has(logicalKey)) return false;
    const site = state.sites[job.origin];
    if (!site || site.binding.generation !== job.bindingGeneration) return false;
    seen.add(logicalKey);
    return true;
  });
}
