import type { DailySchedule, GlobalSettings, StorageState, TriggerKind } from '../shared/domain';
import {
  dateAtLocalMinutes,
  isIsoTimestampOnScheduleDay,
  localScheduleDay,
} from './time';

export type ScheduleWakeCause = 'alarm' | 'startup' | 'settings_changed';
export type DueScheduleTrigger = Extract<TriggerKind, 'scheduled' | 'catchup'>;

export interface EnsureScheduleResult {
  state: StorageState;
  schedule: DailySchedule;
  created: boolean;
}

function assertWindow(settings: GlobalSettings): void {
  const { windowStartMinutes: start, windowEndMinutes: end } = settings;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 * 60 || start >= end) {
    throw new RangeError('The daily check-in window must be a non-empty range within the local day.');
  }
}

function normalizedRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1 - Number.EPSILON);
}

export function createDailySchedule(
  scheduleDay: string,
  settings: GlobalSettings,
  now: Date = new Date(),
  random: () => number = Math.random,
): DailySchedule {
  // Startup mode is due at the first wake that creates it: the batch runs as
  // soon as the browser opens (or the day rolls over under a running browser).
  if (settings.scheduleMode === 'startup') {
    return {
      scheduleDay,
      scheduledAt: now.toISOString(),
      state: 'scheduled',
    };
  }
  assertWindow(settings);
  const start = dateAtLocalMinutes(scheduleDay, settings.windowStartMinutes);
  const end = dateAtLocalMinutes(scheduleDay, settings.windowEndMinutes);
  if (!start || !end) throw new RangeError('Invalid local schedule day.');

  const spanMs = end.getTime() - start.getTime();
  if (spanMs <= 0) throw new RangeError('The local daily window is empty.');
  const scheduledAt = new Date(start.getTime() + Math.floor(normalizedRandom(random) * spanMs));

  return {
    scheduleDay,
    scheduledAt: scheduledAt.toISOString(),
    state: 'scheduled',
  };
}

/** Keeps the first sampled batch time for a day so all sites share one batch. */
export function ensureDailySchedule(
  state: StorageState,
  now: Date = new Date(),
  random: () => number = Math.random,
): EnsureScheduleResult {
  const scheduleDay = localScheduleDay(now);
  const existing = state.schedules[scheduleDay];
  if (existing) return { state, schedule: existing, created: false };

  const schedule = createDailySchedule(scheduleDay, state.settings, now, random);
  return {
    state: {
      ...state,
      schedules: { ...state.schedules, [scheduleDay]: schedule },
    },
    schedule,
    created: true,
  };
}

/**
 * Returns a due trigger only on the schedule's own browser-local day. Alarm wakes
 * are scheduled runs; other same-day wakes after the sampled time are catch-ups.
 */
export function getDueTrigger(
  schedule: DailySchedule,
  now: Date = new Date(),
  cause: ScheduleWakeCause = 'startup',
): DueScheduleTrigger | undefined {
  if (schedule.state !== 'scheduled') return undefined;
  if (localScheduleDay(now) !== schedule.scheduleDay) return undefined;
  if (!isIsoTimestampOnScheduleDay(schedule.scheduledAt, schedule.scheduleDay)) return undefined;

  const scheduledAt = new Date(schedule.scheduledAt);
  if (!Number.isFinite(scheduledAt.getTime()) || now.getTime() < scheduledAt.getTime()) {
    return undefined;
  }

  return cause === 'alarm' ? 'scheduled' : 'catchup';
}

export function markScheduleRunning(
  schedule: DailySchedule,
  now: Date = new Date(),
): DailySchedule {
  if (localScheduleDay(now) !== schedule.scheduleDay) return schedule;
  if (schedule.state === 'complete') return schedule;
  return { ...schedule, state: 'running', startedAt: now.toISOString() };
}

export function markScheduleComplete(
  schedule: DailySchedule,
  now: Date = new Date(),
): DailySchedule {
  if (localScheduleDay(now) !== schedule.scheduleDay) return schedule;
  return {
    ...schedule,
    state: 'complete',
    startedAt: schedule.startedAt ?? now.toISOString(),
    completedAt: now.toISOString(),
  };
}

export function pruneSchedules(
  schedules: Record<string, DailySchedule>,
  currentScheduleDay: string,
): Record<string, DailySchedule> {
  const current = schedules[currentScheduleDay];
  return current ? { [currentScheduleDay]: current } : {};
}
