const SCHEDULE_DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Returns the browser-local calendar day, never a UTC-derived day. */
export function localScheduleDay(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseLocalScheduleDay(scheduleDay: string): Date | undefined {
  const match = SCHEDULE_DAY_PATTERN.exec(scheduleDay);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day, 0, 0, 0, 0);

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return undefined;
  }

  return parsed;
}

export function isSameScheduleDay(left: Date, right: Date): boolean {
  return localScheduleDay(left) === localScheduleDay(right);
}

export function dateAtLocalMinutes(
  scheduleDay: string,
  minutesAfterMidnight: number,
): Date | undefined {
  const midnight = parseLocalScheduleDay(scheduleDay);
  if (!midnight || !Number.isInteger(minutesAfterMidnight)) return undefined;
  if (minutesAfterMidnight < 0 || minutesAfterMidnight > 24 * 60) return undefined;

  return new Date(
    midnight.getFullYear(),
    midnight.getMonth(),
    midnight.getDate(),
    0,
    minutesAfterMidnight,
    0,
    0,
  );
}

export function localMonthQuery(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function isIsoTimestampOnScheduleDay(
  timestamp: string,
  scheduleDay: string,
): boolean {
  const parsed = new Date(timestamp);
  return Number.isFinite(parsed.getTime()) && localScheduleDay(parsed) === scheduleDay;
}
