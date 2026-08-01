import { describe, expect, it } from 'vitest';
import {
  createDailySchedule,
  ensureDailySchedule,
  getDueTrigger,
  localMonthQuery,
  localScheduleDay,
  markScheduleComplete,
  markScheduleRunning,
  parseLocalScheduleDay,
} from '../../../src/core';
import { createDefaultState } from '../../../src/shared/constants';

describe('browser-local time', () => {
  it('formats the browser-local calendar instead of slicing UTC ISO text', () => {
    const date = new Date(2026, 6, 31, 23, 59, 0);
    expect(localScheduleDay(date)).toBe('2026-07-31');
    expect(localMonthQuery(date)).toBe('2026-07');
  });

  it('strictly parses real local calendar days', () => {
    expect(parseLocalScheduleDay('2026-02-29')).toBeUndefined();
    expect(parseLocalScheduleDay('2026-7-01')).toBeUndefined();
    expect(localScheduleDay(parseLocalScheduleDay('2028-02-29')!)).toBe('2028-02-29');
  });
});

describe('daily schedule', () => {
  it('samples once inside the configured global window', () => {
    const schedule = createDailySchedule(
      '2026-07-31',
      { windowStartMinutes: 480, windowEndMinutes: 600, notifyOnSuccess: false },
      () => 0.5,
    );
    const sampled = new Date(schedule.scheduledAt);
    expect(sampled.getHours()).toBe(9);
    expect(sampled.getMinutes()).toBe(0);
    expect(schedule.state).toBe('scheduled');
  });

  it('keeps one sampled batch for every site on the same day', () => {
    const state = createDefaultState();
    const now = new Date(2026, 6, 31, 7, 0);
    const first = ensureDailySchedule(state, now, () => 0.25);
    const second = ensureDailySchedule(first.state, now, () => 0.9);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.schedule.scheduledAt).toBe(first.schedule.scheduledAt);
  });

  it('classifies alarm wakes as scheduled and startup wakes as same-day catch-up', () => {
    const schedule = createDailySchedule(
      '2026-07-31',
      { windowStartMinutes: 480, windowEndMinutes: 600, notifyOnSuccess: false },
      () => 0,
    );
    expect(getDueTrigger(schedule, new Date(2026, 6, 31, 8, 1), 'alarm')).toBe('scheduled');
    expect(getDueTrigger(schedule, new Date(2026, 6, 31, 12, 0), 'startup')).toBe('catchup');
  });

  it('never starts or completes a prior-day batch after midnight', () => {
    const schedule = createDailySchedule(
      '2026-07-31',
      { windowStartMinutes: 480, windowEndMinutes: 600, notifyOnSuccess: false },
      () => 0,
    );
    const nextDay = new Date(2026, 7, 1, 0, 1);
    expect(getDueTrigger(schedule, nextDay, 'startup')).toBeUndefined();
    expect(markScheduleRunning(schedule, nextDay)).toBe(schedule);
    expect(markScheduleComplete(schedule, nextDay)).toBe(schedule);
    expect(
      getDueTrigger(
        { ...schedule, scheduledAt: '2026-07-30T00:00:00.000Z' },
        new Date(2026, 6, 31, 9, 0),
        'alarm',
      ),
    ).toBeUndefined();
  });

  it('records running and complete timestamps on the schedule day', () => {
    const schedule = createDailySchedule(
      '2026-07-31',
      { windowStartMinutes: 480, windowEndMinutes: 600, notifyOnSuccess: false },
      () => 0,
    );
    const running = markScheduleRunning(schedule, new Date(2026, 6, 31, 8, 0));
    const complete = markScheduleComplete(running, new Date(2026, 6, 31, 8, 10));
    expect(running.state).toBe('running');
    expect(complete.state).toBe('complete');
    expect(complete.startedAt).toBe(running.startedAt);
  });

  it('rejects invalid windows', () => {
    expect(() =>
      createDailySchedule(
        '2026-07-31',
        { windowStartMinutes: 600, windowEndMinutes: 480, notifyOnSuccess: false },
      ),
    ).toThrow(RangeError);
  });
});
